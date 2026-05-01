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
        janus_ws_url: cfg_str(
            "JANUS_WS_URL",
            option_env!("JANUS_WS_URL"),
            "ws://localhost:8188",
        ),
        room_id: cfg_int("ROOM_ID", option_env!("ROOM_ID"), 1001),
        room_pin: cfg_opt("ROOM_PIN", option_env!("ROOM_PIN")),
        ice_servers: vec![
            IceServer {
                urls: vec![cfg_str(
                    "STUN_URL",
                    option_env!("STUN_URL"),
                    "stun:localhost:3478",
                )],
                username: None,
                credential: None,
            },
            IceServer {
                urls: vec![cfg_str(
                    "TURN_URL",
                    option_env!("TURN_URL"),
                    "turn:localhost:3478?transport=udp",
                )],
                username: Some(cfg_str(
                    "TURN_USERNAME",
                    option_env!("TURN_USERNAME"),
                    "room",
                )),
                credential: Some(cfg_str(
                    "TURN_PASSWORD",
                    option_env!("TURN_PASSWORD"),
                    "room-secret",
                )),
            },
        ],
    }
}

fn cfg_str(key: &str, baked: Option<&'static str>, fallback: &str) -> String {
    if let Some(v) = env::var(key).ok().filter(|s| !s.is_empty()) {
        return v;
    }
    if let Some(v) = baked.filter(|s| !s.is_empty()) {
        return v.to_string();
    }
    fallback.to_string()
}

fn cfg_int(key: &str, baked: Option<&'static str>, fallback: i32) -> i32 {
    env::var(key)
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| baked.filter(|s| !s.is_empty()).map(String::from))
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(fallback)
}

fn cfg_opt(key: &str, baked: Option<&'static str>) -> Option<String> {
    env::var(key)
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| baked.filter(|s| !s.is_empty()).map(String::from))
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_app_config])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
