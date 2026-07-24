mod native_bridge;

use native_bridge::{register_native_host, request as request_browser, start_bridge_listener, BridgeState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

const KEYRING_SERVICE: &str = "club.neptune.runtime";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    available: bool,
    models: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BrowserAction {
    id: String,
    #[serde(rename = "type")]
    action_type: String,
    label: String,
    risk: String,
    requires_approval: bool,
    target: Option<Value>,
    value: Option<String>,
    url: Option<String>,
    delay_ms: Option<u64>,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlannedAction {
    #[serde(rename = "type")]
    action_type: String,
    label: Option<String>,
    risk: Option<String>,
    requires_approval: Option<bool>,
    target: Option<Value>,
    value: Option<String>,
    url: Option<String>,
    delay_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct PlannedResponse {
    text: String,
    #[serde(default)]
    actions: Vec<PlannedAction>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeReply {
    text: String,
    requires_permission: bool,
    blocked_reason: Option<String>,
    actions: Vec<BrowserAction>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeStatus {
    connected: bool,
    host_registered: bool,
    extension_id: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallResult {
    model: String,
    status: String,
}

#[tauri::command]
async fn probe_provider(provider_id: String, endpoint: Option<String>) -> Result<ProbeResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|error| error.to_string())?;

    match provider_id.as_str() {
        "lm-studio" => {
            let base = endpoint.unwrap_or_else(|| "http://127.0.0.1:1234".to_string());
            let payload: Value = client
                .get(format!("{}/v1/models", base.trim_end_matches('/')))
                .send()
                .await
                .map_err(|error| error.to_string())?
                .error_for_status()
                .map_err(|error| error.to_string())?
                .json()
                .await
                .map_err(|error| error.to_string())?;
            let models = payload["data"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item["id"].as_str().map(ToOwned::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            Ok(ProbeResult { available: true, models })
        }
        "ollama" => {
            let base = endpoint.unwrap_or_else(|| "http://127.0.0.1:11434".to_string());
            let payload: Value = client
                .get(format!("{}/api/tags", base.trim_end_matches('/')))
                .send()
                .await
                .map_err(|error| error.to_string())?
                .error_for_status()
                .map_err(|error| error.to_string())?
                .json()
                .await
                .map_err(|error| error.to_string())?;
            let models = payload["models"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item["name"].as_str().map(ToOwned::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            Ok(ProbeResult { available: true, models })
        }
        _ => Ok(ProbeResult { available: false, models: vec![] }),
    }
}

#[tauri::command]
async fn install_ollama_model(endpoint: Option<String>, model: String) -> Result<InstallResult, String> {
    let model = model.trim().to_string();
    if model.is_empty() || model.len() > 160 {
        return Err("Le nom du modèle Ollama est invalide.".to_string());
    }
    let base = endpoint.unwrap_or_else(|| "http://127.0.0.1:11434".to_string());
    let response: Value = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60 * 30))
        .build()
        .map_err(|error| error.to_string())?
        .post(format!("{}/api/pull", base.trim_end_matches('/')))
        .json(&json!({ "model": model, "stream": false }))
        .send()
        .await
        .map_err(|error| format!("Ollama est inaccessible : {error}"))?
        .error_for_status()
        .map_err(|error| format!("Ollama a refusé le téléchargement : {error}"))?
        .json()
        .await
        .map_err(|error| format!("Réponse Ollama invalide : {error}"))?;
    Ok(InstallResult {
        model,
        status: response["status"].as_str().unwrap_or("success").to_string(),
    })
}

#[tauri::command]
fn save_provider_secret(provider_id: String, secret: String) -> Result<(), String> {
    if secret.trim().len() < 8 {
        return Err("La clé fournie paraît invalide.".to_string());
    }
    let entry = keyring::Entry::new(KEYRING_SERVICE, &provider_id)
        .map_err(|error| format!("Coffre système indisponible : {error}"))?;
    entry
        .set_password(secret.trim())
        .map_err(|error| format!("Impossible d'enregistrer la clé : {error}"))
}

#[tauri::command]
async fn chat(
    provider_id: String,
    endpoint: Option<String>,
    model: String,
    messages: Vec<ChatMessage>,
    user_name: String,
) -> Result<RuntimeReply, String> {
    if model.trim().is_empty() {
        return Err("Aucun modèle sélectionné.".to_string());
    }
    let system = ChatMessage {
        role: "system".to_string(),
        content: format!(
            "Tu es Neptune, un assistant professionnel, direct et fiable. L'utilisateur s'appelle {}. N'utilise son prénom que lorsqu'il améliore réellement l'échange. Explique les blocages clairement et ne prétends jamais avoir effectué une action navigateur si aucune action n'a été exécutée.",
            user_name.trim()
        ),
    };
    let mut conversation = vec![system];
    conversation.extend(messages.into_iter().take(20));
    let text = completion_text(&provider_id, endpoint, &model, conversation).await?;
    Ok(RuntimeReply {
        text,
        requires_permission: false,
        blocked_reason: None,
        actions: vec![],
    })
}

#[tauri::command]
async fn plan_browser_task(
    provider_id: String,
    endpoint: Option<String>,
    model: String,
    goal: String,
    user_name: String,
    trust_level: String,
) -> Result<RuntimeReply, String> {
    let system = ChatMessage {
        role: "system".to_string(),
        content: format!(
            r#"Tu es le planificateur navigateur de Neptune. Réponds UNIQUEMENT par un objet JSON valide, sans markdown :
{{"text":"phrase courte adressée à l'utilisateur","actions":[...]}}
Actions autorisées : OPEN_URL, READ_PAGE, CLICK_ELEMENT, FILL_FIELD, SEND_MESSAGE, WAIT.
Chaque action contient : type, label, risk (read_only|draft_write|external_write|sensitive), requiresApproval, et selon le cas url, target {{role,name,text,selector}}, value, delayMs.
OPEN_URL et READ_PAGE sont read_only. SEND_MESSAGE est toujours external_write et requiresApproval=true. Ne crée jamais d'action de paiement, suppression, mot de passe, signature ou contournement de CAPTCHA. Pour un site connu, donne une URL HTTPS complète. Le niveau de confiance configuré est {trust_level}. L'utilisateur s'appelle {user_name}."#
        ),
    };
    let messages = vec![
        system,
        ChatMessage { role: "user".to_string(), content: goal },
    ];
    let raw = completion_text(&provider_id, endpoint, &model, messages).await?;
    let parsed = parse_planned_response(&raw).unwrap_or(PlannedResponse {
        text: raw,
        actions: vec![],
    });
    let actions = parsed
        .actions
        .into_iter()
        .filter_map(normalize_action)
        .take(30)
        .collect::<Vec<_>>();
    let requires_permission = actions.iter().any(|action| action.requires_approval);
    Ok(RuntimeReply {
        text: parsed.text,
        requires_permission,
        blocked_reason: None,
        actions,
    })
}

fn parse_planned_response(raw: &str) -> Option<PlannedResponse> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    serde_json::from_str(&raw[start..=end]).ok()
}

fn normalize_action(action: PlannedAction) -> Option<BrowserAction> {
    let allowed = ["OPEN_URL", "READ_PAGE", "CLICK_ELEMENT", "FILL_FIELD", "SEND_MESSAGE", "WAIT"];
    if !allowed.contains(&action.action_type.as_str()) {
        return None;
    }
    let mut risk = action.risk.unwrap_or_else(|| "read_only".to_string());
    if !["read_only", "draft_write", "external_write", "sensitive"].contains(&risk.as_str()) {
        risk = "read_only".to_string();
    }
    let mut requires_approval = action.requires_approval.unwrap_or(false);
    if action.action_type == "SEND_MESSAGE" {
        risk = "external_write".to_string();
        requires_approval = true;
    }
    if risk == "external_write" || risk == "sensitive" {
        requires_approval = true;
    }
    Some(BrowserAction {
        id: uuid::Uuid::new_v4().to_string(),
        label: action.label.unwrap_or_else(|| action.action_type.clone()),
        action_type: action.action_type,
        risk,
        requires_approval,
        target: action.target,
        value: action.value,
        url: action.url,
        delay_ms: action.delay_ms.map(|value| value.min(60_000)),
        status: "pending".to_string(),
    })
}

async fn completion_text(
    provider_id: &str,
    endpoint: Option<String>,
    model: &str,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    if provider_id == "ollama" {
        return completion_ollama(endpoint, model, messages).await;
    }
    completion_openai_compatible(provider_id, endpoint, model, messages).await
}

async fn completion_ollama(
    endpoint: Option<String>,
    model: &str,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let base = endpoint.unwrap_or_else(|| "http://127.0.0.1:11434".to_string());
    let response: Value = reqwest::Client::new()
        .post(format!("{}/api/chat", base.trim_end_matches('/')))
        .json(&json!({ "model": model, "messages": messages, "stream": false }))
        .send()
        .await
        .map_err(|error| format!("Ollama est inaccessible : {error}"))?
        .error_for_status()
        .map_err(|error| format!("Ollama a refusé la requête : {error}"))?
        .json()
        .await
        .map_err(|error| format!("Réponse Ollama invalide : {error}"))?;
    response["message"]["content"]
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "Ollama n'a renvoyé aucun texte.".to_string())
}

async fn completion_openai_compatible(
    provider_id: &str,
    endpoint: Option<String>,
    model: &str,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let base = match (provider_id, endpoint) {
        ("lm-studio", Some(value)) => value,
        ("lm-studio", None) => "http://127.0.0.1:1234".to_string(),
        (_, Some(value)) if value.starts_with("https://") || value.starts_with("http://127.0.0.1") => value,
        _ => return Err("L'adresse API de ce fournisseur doit être configurée.".to_string()),
    };
    let mut request = reqwest::Client::new()
        .post(format!("{}/v1/chat/completions", base.trim_end_matches('/')))
        .json(&json!({ "model": model, "messages": messages, "stream": false }));
    if provider_id != "lm-studio" {
        let entry = keyring::Entry::new(KEYRING_SERVICE, provider_id)
            .map_err(|error| format!("Coffre système indisponible : {error}"))?;
        let secret = entry
            .get_password()
            .map_err(|_| "Aucune clé n'est enregistrée pour ce fournisseur.".to_string())?;
        request = request.bearer_auth(secret);
    }
    let response: Value = request
        .send()
        .await
        .map_err(|error| format!("Moteur inaccessible : {error}"))?
        .error_for_status()
        .map_err(|error| format!("Le fournisseur a refusé la requête : {error}"))?
        .json()
        .await
        .map_err(|error| format!("Réponse fournisseur invalide : {error}"))?;
    response["choices"][0]["message"]["content"]
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "Le moteur n'a renvoyé aucun texte.".to_string())
}

#[tauri::command]
fn native_bridge_status(state: tauri::State<'_, Arc<BridgeState>>) -> BridgeStatus {
    BridgeStatus {
        connected: state.connected(),
        host_registered: cfg!(target_os = "windows"),
        extension_id: "mhjkecpebpekcdbnhfmdiemlkfaafidh",
    }
}

#[tauri::command]
fn register_browser_extension_host() -> Result<String, String> {
    register_native_host().map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
async fn browser_request(
    state: tauri::State<'_, Arc<BridgeState>>,
    payload: Value,
) -> Result<Value, String> {
    let bridge = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || request_browser(bridge, payload))
        .await
        .map_err(|error| format!("Le pont navigateur s’est interrompu : {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let bridge = Arc::new(BridgeState::default());
    start_bridge_listener(bridge.clone());
    tauri::Builder::default()
        .manage(bridge)
        .setup(|_| {
            if let Err(error) = register_native_host() {
                eprintln!("Native host registration skipped: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_provider,
            install_ollama_model,
            save_provider_secret,
            chat,
            plan_browser_task,
            native_bridge_status,
            register_browser_extension_host,
            browser_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running Neptune Runtime");
}

pub fn run_native_host() -> Result<(), String> {
    native_bridge::run_native_host()
}
