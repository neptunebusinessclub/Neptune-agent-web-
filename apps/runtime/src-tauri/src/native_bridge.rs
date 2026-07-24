use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::Command,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};

const BRIDGE_ADDRESS: &str = "127.0.0.1:38127";
const HOST_NAME: &str = "club.neptune.runtime";
const EXTENSION_ID: &str = "mhjkecpebpekcdbnhfmdiemlkfaafidh";

#[derive(Default)]
pub struct BridgeState {
    writer: Mutex<Option<TcpStream>>,
    pending: Mutex<HashMap<String, mpsc::Sender<Value>>>,
}

impl BridgeState {
    pub fn connected(&self) -> bool {
        self.writer.lock().map(|guard| guard.is_some()).unwrap_or(false)
    }
}

pub fn start_bridge_listener(state: Arc<BridgeState>) {
    thread::spawn(move || {
        let listener = match TcpListener::bind(BRIDGE_ADDRESS) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("Neptune bridge unavailable: {error}");
                return;
            }
        };

        for incoming in listener.incoming() {
            let stream = match incoming {
                Ok(stream) => stream,
                Err(error) => {
                    eprintln!("Neptune bridge accept failed: {error}");
                    continue;
                }
            };
            let reader_stream = match stream.try_clone() {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("Neptune bridge clone failed: {error}");
                    continue;
                }
            };
            if let Ok(mut writer) = state.writer.lock() {
                *writer = Some(stream);
            }

            let state_for_reader = state.clone();
            thread::spawn(move || {
                let reader = BufReader::new(reader_stream);
                for line in reader.lines() {
                    let line = match line {
                        Ok(value) => value,
                        Err(_) => break,
                    };
                    let value: Value = match serde_json::from_str(&line) {
                        Ok(value) => value,
                        Err(_) => continue,
                    };
                    let request_id = value
                        .get("requestId")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned);
                    if let Some(request_id) = request_id {
                        let sender = state_for_reader
                            .pending
                            .lock()
                            .ok()
                            .and_then(|mut pending| pending.remove(&request_id));
                        if let Some(sender) = sender {
                            let _ = sender.send(value);
                        }
                    }
                }
                if let Ok(mut writer) = state_for_reader.writer.lock() {
                    *writer = None;
                }
            });
        }
    });
}

pub fn request(state: Arc<BridgeState>, mut payload: Value) -> Result<Value, String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let object = payload
        .as_object_mut()
        .ok_or_else(|| "La commande navigateur doit être un objet JSON.".to_string())?;
    object.insert("requestId".to_string(), Value::String(request_id.clone()));

    let (sender, receiver) = mpsc::channel();
    state
        .pending
        .lock()
        .map_err(|_| "Le pont navigateur est verrouillé.".to_string())?
        .insert(request_id.clone(), sender);

    let line = format!("{}\n", serde_json::to_string(&payload).map_err(|error| error.to_string())?);
    let write_result = state
        .writer
        .lock()
        .map_err(|_| "Le pont navigateur est verrouillé.".to_string())?
        .as_mut()
        .ok_or_else(|| "L’extension Neptune n’est pas connectée. Rechargez-la dans Chrome puis réessayez.".to_string())?
        .write_all(line.as_bytes());

    if let Err(error) = write_result {
        if let Ok(mut pending) = state.pending.lock() {
            pending.remove(&request_id);
        }
        return Err(format!("Impossible de joindre l’extension Neptune : {error}"));
    }

    receiver
        .recv_timeout(Duration::from_secs(35))
        .map_err(|_| "L’extension Neptune n’a pas répondu dans le délai prévu.".to_string())
}

pub fn register_native_host() -> Result<PathBuf, String> {
    #[cfg(not(target_os = "windows"))]
    {
        return Err("L’enregistrement automatique du pont est disponible sur Windows pour ce lot.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| "LOCALAPPDATA est indisponible.".to_string())?;
        let host_directory = local_app_data.join("Neptune").join("NativeMessaging");
        fs::create_dir_all(&host_directory).map_err(|error| error.to_string())?;
        let manifest_path = host_directory.join(format!("{HOST_NAME}.json"));
        let manifest = json!({
            "name": HOST_NAME,
            "description": "Pont sécurisé entre Neptune Runtime et l’extension navigateur",
            "path": executable,
            "type": "stdio",
            "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")]
        });
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;

        for registry_path in [
            format!(r"HKCU\Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"),
            format!(r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts\{HOST_NAME}"),
        ] {
            let status = Command::new("reg")
                .args([
                    "ADD",
                    &registry_path,
                    "/ve",
                    "/t",
                    "REG_SZ",
                    "/d",
                    manifest_path.to_string_lossy().as_ref(),
                    "/f",
                ])
                .status()
                .map_err(|error| format!("Impossible d’ouvrir le registre Windows : {error}"))?;
            if !status.success() {
                return Err(format!("L’enregistrement du pont a échoué pour {registry_path}."));
            }
        }
        Ok(manifest_path)
    }
}

pub fn run_native_host() -> Result<(), String> {
    set_binary_stdio();
    let mut bridge = TcpStream::connect_timeout(
        &BRIDGE_ADDRESS.parse().map_err(|error: std::net::AddrParseError| error.to_string())?,
        Duration::from_secs(3),
    )
    .map_err(|_| "Neptune Runtime doit être ouvert pour piloter le navigateur.".to_string())?;
    let bridge_reader = bridge.try_clone().map_err(|error| error.to_string())?;

    thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut input = stdin.lock();
        loop {
            let mut size_buffer = [0_u8; 4];
            if input.read_exact(&mut size_buffer).is_err() {
                break;
            }
            let size = u32::from_le_bytes(size_buffer) as usize;
            if size == 0 || size > 64 * 1024 * 1024 {
                break;
            }
            let mut message = vec![0_u8; size];
            if input.read_exact(&mut message).is_err() {
                break;
            }
            if bridge.write_all(&message).is_err() || bridge.write_all(b"\n").is_err() {
                break;
            }
        }
    });

    let reader = BufReader::new(bridge_reader);
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    for line in reader.lines() {
        let line = line.map_err(|error| error.to_string())?;
        let bytes = line.as_bytes();
        if bytes.len() > 1024 * 1024 {
            continue;
        }
        output
            .write_all(&(bytes.len() as u32).to_le_bytes())
            .and_then(|_| output.write_all(bytes))
            .and_then(|_| output.flush())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn set_binary_stdio() {
    const O_BINARY: i32 = 0x8000;
    extern "C" {
        fn _setmode(fd: i32, mode: i32) -> i32;
    }
    unsafe {
        _setmode(0, O_BINARY);
        _setmode(1, O_BINARY);
    }
}

#[cfg(not(target_os = "windows"))]
fn set_binary_stdio() {}
