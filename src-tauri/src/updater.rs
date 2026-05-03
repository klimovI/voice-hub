// Updater state machine.
//
// Owns: UpdaterState, check cadence, download/install flow.
// Does NOT own: tray construction — that lives in tray.rs.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::tray;

const INTERVAL: Duration = Duration::from_secs(60 * 60);
const FOCUS_THROTTLE: Duration = Duration::from_secs(15 * 60);
const PROGRESS_EMIT_THROTTLE: Duration = Duration::from_millis(100);

pub struct UpdaterState {
    last_checked: Option<Instant>,
    pending: Option<Update>,
    installing: bool,
}

impl UpdaterState {
    fn new() -> Self {
        Self {
            last_checked: None,
            pending: None,
            installing: false,
        }
    }
}

pub type SharedUpdater = Arc<Mutex<UpdaterState>>;

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let state: SharedUpdater = Arc::new(Mutex::new(UpdaterState::new()));
    app.manage(state.clone());

    tray::init(app)?;

    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        check(h, /* force */ true).await;
    });

    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(INTERVAL).await;
            check(h.clone(), /* force */ true).await;
        }
    });

    Ok(())
}

pub async fn check_on_focus(app: AppHandle) {
    check(app, /* force */ false).await;
}

/// Force an immediate update check. Called from the tray "Check for updates"
/// item so it must be `pub`.
pub async fn check_forced(app: AppHandle) {
    check(app, /* force */ true).await;
}

async fn check(app: AppHandle, force: bool) {
    let shared: SharedUpdater = match app.try_state::<SharedUpdater>() {
        Some(s) => s.inner().clone(),
        None => return,
    };

    if !force {
        if let Ok(s) = shared.lock() {
            if let Some(prev) = s.last_checked {
                if prev.elapsed() < FOCUS_THROTTLE {
                    return;
                }
            }
        }
    }

    if let Ok(mut s) = shared.lock() {
        s.last_checked = Some(Instant::now());
    }

    let updater = match app.updater() {
        Ok(u) => u,
        Err(err) => {
            log::error!("updater: build failed: {err}");
            return;
        }
    };
    let result = updater.check().await;
    let update = match result {
        Ok(Some(u)) => u,
        Ok(None) => return,
        Err(err) => {
            log::error!("updater: check failed: {err}");
            return;
        }
    };

    let version = update.version.clone();
    if let Ok(mut s) = shared.lock() {
        let already_known = s
            .pending
            .as_ref()
            .map(|u| u.version == version)
            .unwrap_or(false);
        s.pending = Some(update);
        if already_known {
            return;
        }
    }

    let _ = app.emit("update-available", serde_json::json!({ "version": version }));
    if let Err(err) = tray::set_update_available(&app, &version) {
        log::error!("updater: tray rebuild failed: {err}");
    }
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) {
    check(app, /* force */ true).await;
}

#[tauri::command]
pub async fn apply_update(app: AppHandle) -> Result<(), String> {
    {
        let state = app
            .try_state::<SharedUpdater>()
            .ok_or_else(|| "updater state missing".to_string())?;
        let mut s = state.lock().map_err(|e| format!("lock: {e}"))?;
        if s.installing {
            return Err("install already in progress".to_string());
        }
        if s.pending.is_none() {
            return Err("no pending update".to_string());
        }
        s.installing = true;
    }

    let result = run_install(app.clone()).await;

    if let Err(ref err) = result {
        log::error!("updater: install failed: {err}");
        if let Some(state) = app.try_state::<SharedUpdater>() {
            if let Ok(mut s) = state.lock() {
                s.installing = false;
                s.pending = None;
            }
        }
        let _ = app.emit("update-error", serde_json::json!({ "message": err }));
        // Re-discover the update so tray + banner can offer a retry.
        let h = app.clone();
        tauri::async_runtime::spawn(async move {
            check(h, true).await;
        });
    }

    result
}

async fn run_install(app: AppHandle) -> Result<(), String> {
    let update = {
        let state = app
            .try_state::<SharedUpdater>()
            .ok_or_else(|| "updater state missing".to_string())?;
        let mut s = state.lock().map_err(|e| format!("lock: {e}"))?;
        s.pending.take().ok_or_else(|| "no pending update".to_string())?
    };

    let downloaded = Arc::new(Mutex::new(0u64));
    let last_emit = Arc::new(Mutex::new(Instant::now() - PROGRESS_EMIT_THROTTLE));
    let app_chunk = app.clone();
    let app_finish = app.clone();

    update
        .download_and_install(
            move |chunk_len, content_len| {
                let total = {
                    let mut d = match downloaded.lock() {
                        Ok(g) => g,
                        Err(p) => p.into_inner(),
                    };
                    *d += chunk_len as u64;
                    *d
                };
                let should_emit = {
                    let mut t = match last_emit.lock() {
                        Ok(g) => g,
                        Err(p) => p.into_inner(),
                    };
                    let done = content_len.map(|c| total >= c).unwrap_or(false);
                    if done || t.elapsed() >= PROGRESS_EMIT_THROTTLE {
                        *t = Instant::now();
                        true
                    } else {
                        false
                    }
                };
                if should_emit {
                    let _ = app_chunk.emit(
                        "update-progress",
                        serde_json::json!({ "downloaded": total, "total": content_len }),
                    );
                }
            },
            move || {
                let _ = app_finish.emit("update-installing", serde_json::json!({}));
            },
        )
        .await
        .map_err(|e| format!("install: {e}"))?;

    app.restart();
}
