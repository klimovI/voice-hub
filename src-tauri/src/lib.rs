use serde::Serialize;
use std::env;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IceServer {
    urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppConfigResponse {
    janus_ws_url: String,
    room_id: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    room_pin: Option<String>,
    ice_servers: Vec<IceServer>,
}

#[tauri::command]
fn get_app_config() -> AppConfigResponse {
    AppConfigResponse {
        janus_ws_url: env_or("JANUS_WS_URL", "ws://localhost:8188"),
        room_id: env_or_int("ROOM_ID", 1001),
        room_pin: env::var("ROOM_PIN").ok().filter(|value| !value.is_empty()),
        ice_servers: vec![
            IceServer {
                urls: vec![env_or("STUN_URL", "stun:localhost:3478")],
                username: None,
                credential: None,
            },
            IceServer {
                urls: vec![env_or("TURN_URL", "turn:localhost:3478?transport=udp")],
                username: Some(env_or("TURN_USERNAME", "room")),
                credential: Some(env_or("TURN_PASSWORD", "room-secret")),
            },
        ],
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    env::var(key)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn env_or_int(key: &str, fallback: i32) -> i32 {
    env::var(key)
        .ok()
        .and_then(|value| value.parse::<i32>().ok())
        .unwrap_or(fallback)
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_app_config])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
