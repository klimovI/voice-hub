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

/// Result of attempting to load the persisted binding.
pub enum LoadResult {
    /// No config file (or unreadable/unparseable) — treat as first run.
    Missing,
    /// File present, user explicitly cleared the binding.
    Cleared,
    /// File present, user set this binding.
    Bound(InputBinding),
}

/// Load persisted binding choice. See `LoadResult` for the three states.
pub fn load(app: &tauri::AppHandle) -> LoadResult {
    let Ok(path) = config_path(app) else {
        return LoadResult::Missing;
    };
    let Ok(raw) = fs::read(&path) else {
        return LoadResult::Missing;
    };
    match serde_json::from_slice::<Option<InputBinding>>(&raw) {
        Ok(Some(b)) => LoadResult::Bound(b),
        Ok(None) => LoadResult::Cleared,
        Err(_) => LoadResult::Missing,
    }
}

pub fn save(app: &tauri::AppHandle, binding: Option<&InputBinding>) -> Result<(), String> {
    let path = config_path(app)?;
    let json = serde_json::to_vec_pretty(&binding).map_err(|e| format!("serialize: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("write {}: {e}", path.display()))
}
