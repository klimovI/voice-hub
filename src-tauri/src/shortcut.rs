use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InputBinding {
    Keyboard { keys: Vec<String> },
    Mouse { button: String },
}

impl InputBinding {
    pub fn default_combo() -> Self {
        InputBinding::Keyboard {
            keys: vec!["Ctrl".into(), "Shift".into(), "M".into()],
        }
    }
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir config dir: {e}"))?;
    Ok(dir.join("shortcut.json"))
}

pub fn load(app: &tauri::AppHandle) -> Option<InputBinding> {
    let path = config_path(app).ok()?;
    let raw = fs::read(&path).ok()?;
    serde_json::from_slice::<InputBinding>(&raw).ok()
}

pub fn save(app: &tauri::AppHandle, binding: &InputBinding) -> Result<(), String> {
    let path = config_path(app)?;
    let json = serde_json::to_vec_pretty(binding).map_err(|e| format!("serialize: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("write {}: {e}", path.display()))
}
