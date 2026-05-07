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
    let path = match config_path(app) {
        Ok(p) => p,
        Err(err) => {
            log::warn!("shortcut: resolve config path failed: {err}");
            return LoadResult::Missing;
        }
    };
    let raw = match fs::read(&path) {
        Ok(r) => r,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return LoadResult::Missing,
        Err(err) => {
            log::warn!("shortcut: read {} failed: {err}", path.display());
            return LoadResult::Missing;
        }
    };
    match serde_json::from_slice::<Option<InputBinding>>(&raw) {
        Ok(Some(b)) => LoadResult::Bound(b),
        Ok(None) => LoadResult::Cleared,
        Err(err) => {
            log::warn!("shortcut: parse {} failed: {err}", path.display());
            LoadResult::Missing
        }
    }
}

pub fn save(app: &tauri::AppHandle, binding: Option<&InputBinding>) -> Result<(), String> {
    let path = config_path(app)?;
    let json = serde_json::to_vec_pretty(&binding).map_err(|e| format!("serialize: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies that each binding fixture file round-trips through
    /// `serde_json::from_str` → `serde_json::to_string_pretty` byte-for-byte.
    /// The fixture files are the authoritative storage contract; this test
    /// locks down that Rust serde never silently changes the on-disk format.
    #[test]
    fn binding_fixtures_roundtrip() {
        let fixtures: &[(&str, &str)] = &[
            (
                "binding-keyboard-plain",
                include_str!("../testdata/binding-keyboard-plain.json"),
            ),
            (
                "binding-keyboard-modifiers",
                include_str!("../testdata/binding-keyboard-modifiers.json"),
            ),
            (
                "binding-mouse",
                include_str!("../testdata/binding-mouse.json"),
            ),
            (
                "binding-cleared",
                include_str!("../testdata/binding-cleared.json"),
            ),
        ];

        for (name, content) in fixtures {
            let parsed: Option<InputBinding> = serde_json::from_str(content)
                .unwrap_or_else(|e| panic!("fixture {name}: failed to parse: {e}"));
            let serialised = serde_json::to_string_pretty(&parsed)
                .unwrap_or_else(|e| panic!("fixture {name}: failed to serialise: {e}"));
            assert_eq!(
                serialised, *content,
                "fixture {name}: re-serialised output does not match fixture bytes\n\
                 got:  {serialised:?}\n\
                 want: {content:?}"
            );
        }
    }
}
