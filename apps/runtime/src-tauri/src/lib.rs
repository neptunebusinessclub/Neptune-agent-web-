use serde::{Deserialize, Serialize};
use serde_json::json;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeReply {
    text: String,
    requires_permission: bool,
    blocked_reason: Option<String>,
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
            let payload: serde_json::Value = client
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
            let payload: serde_json::Value = client
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
            "Tu es Neptune, un assistant professionnel, direct et fiable. L'utilisateur s'appelle {}. N'utilise son prénom que lorsqu'il améliore réellement l'échange. Tu expliques clairement les blocages et tu demandes une autorisation avant toute action externe sensible.",
            user_name.trim()
        ),
    };
    let mut conversation = vec![system];
    conversation.extend(messages.into_iter().take(20));

    if provider_id == "ollama" {
        return chat_ollama(endpoint, model, conversation).await;
    }
    chat_openai_compatible(provider_id, endpoint, model, conversation).await
}

async fn chat_ollama(
    endpoint: Option<String>,
    model: String,
    messages: Vec<ChatMessage>,
) -> Result<RuntimeReply, String> {
    let base = endpoint.unwrap_or_else(|| "http://127.0.0.1:11434".to_string());
    let response: serde_json::Value = reqwest::Client::new()
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

    let text = response["message"]["content"]
        .as_str()
        .ok_or_else(|| "Ollama n'a renvoyé aucun texte.".to_string())?;
    Ok(RuntimeReply {
        text: text.to_string(),
        requires_permission: false,
        blocked_reason: None,
    })
}

async fn chat_openai_compatible(
    provider_id: String,
    endpoint: Option<String>,
    model: String,
    messages: Vec<ChatMessage>,
) -> Result<RuntimeReply, String> {
    let base = match (provider_id.as_str(), endpoint) {
        ("lm-studio", Some(value)) => value,
        ("lm-studio", None) => "http://127.0.0.1:1234".to_string(),
        (_, Some(value)) if value.starts_with("https://") || value.starts_with("http://127.0.0.1") => value,
        _ => return Err("L'adresse API de ce fournisseur doit être configurée.".to_string()),
    };

    let mut request = reqwest::Client::new()
        .post(format!("{}/v1/chat/completions", base.trim_end_matches('/')))
        .json(&json!({ "model": model, "messages": messages, "stream": false }));

    if provider_id != "lm-studio" {
        let entry = keyring::Entry::new(KEYRING_SERVICE, &provider_id)
            .map_err(|error| format!("Coffre système indisponible : {error}"))?;
        let secret = entry
            .get_password()
            .map_err(|_| "Aucune clé n'est enregistrée pour ce fournisseur.".to_string())?;
        request = request.bearer_auth(secret);
    }

    let response: serde_json::Value = request
        .send()
        .await
        .map_err(|error| format!("Moteur inaccessible : {error}"))?
        .error_for_status()
        .map_err(|error| format!("Le fournisseur a refusé la requête : {error}"))?
        .json()
        .await
        .map_err(|error| format!("Réponse fournisseur invalide : {error}"))?;

    let text = response["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| "Le moteur n'a renvoyé aucun texte.".to_string())?;
    Ok(RuntimeReply {
        text: text.to_string(),
        requires_permission: false,
        blocked_reason: None,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![probe_provider, save_provider_secret, chat])
        .run(tauri::generate_context!())
        .expect("error while running Neptune Runtime");
}
