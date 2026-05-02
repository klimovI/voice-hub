use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::connection;
use crate::QuitFlag;

const INTERVAL: Duration = Duration::from_secs(60 * 60);
const FOCUS_THROTTLE: Duration = Duration::from_secs(15 * 60);
const PROGRESS_EMIT_THROTTLE: Duration = Duration::from_millis(100);

const TRAY_ID: &str = "main";
const ITEM_UPDATE: &str = "update_apply";
const ITEM_CHECK: &str = "update_check";
const ITEM_SHOW: &str = "show_window";
const ITEM_CHANGE_SERVER: &str = "change_server";
const ITEM_DISCONNECT: &str = "disconnect";
const ITEM_QUIT: &str = "quit";

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

    build_tray(app)?;

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
            eprintln!("updater: build failed: {err}");
            return;
        }
    };
    let result = updater.check().await;
    let update = match result {
        Ok(Some(u)) => u,
        Ok(None) => return,
        Err(err) => {
            eprintln!("updater: check failed: {err}");
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
    if let Err(err) = update_tray_for_available(&app, &version) {
        eprintln!("updater: tray rebuild failed: {err}");
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
        eprintln!("updater: install failed: {err}");
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

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = base_menu(app)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().cloned().expect("default icon"))
        .tooltip("Voice Hub")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn base_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let connected = connection::load_host().is_some();
    let show = MenuItem::with_id(app, ITEM_SHOW, "Show Voice Hub", true, None::<&str>)?;
    let check = MenuItem::with_id(app, ITEM_CHECK, "Check for updates", true, None::<&str>)?;
    let change = MenuItem::with_id(app, ITEM_CHANGE_SERVER, "Change server", true, None::<&str>)?;
    let disconnect =
        MenuItem::with_id(app, ITEM_DISCONNECT, "Disconnect", connected, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, ITEM_QUIT, "Quit", true, None::<&str>)?;
    MenuBuilder::new(app)
        .item(&show)
        .item(&check)
        .item(&sep1)
        .item(&change)
        .item(&disconnect)
        .item(&sep2)
        .item(&quit)
        .build()
}

fn update_tray_for_available(app: &AppHandle, version: &str) -> tauri::Result<()> {
    let connected = connection::load_host().is_some();
    let label = format!("Install v{version}");
    let apply = MenuItem::with_id(app, ITEM_UPDATE, &label, true, None::<&str>)?;
    let show = MenuItem::with_id(app, ITEM_SHOW, "Show Voice Hub", true, None::<&str>)?;
    let check = MenuItem::with_id(app, ITEM_CHECK, "Check for updates", true, None::<&str>)?;
    let change = MenuItem::with_id(app, ITEM_CHANGE_SERVER, "Change server", true, None::<&str>)?;
    let disconnect =
        MenuItem::with_id(app, ITEM_DISCONNECT, "Disconnect", connected, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, ITEM_QUIT, "Quit", true, None::<&str>)?;
    let menu = MenuBuilder::new(app)
        .item(&apply)
        .item(&sep1)
        .item(&show)
        .item(&check)
        .item(&sep2)
        .item(&change)
        .item(&disconnect)
        .item(&sep3)
        .item(&quit)
        .build()?;

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))?;
        tray.set_tooltip(Some(format!("Voice Hub — v{version} available")))?;
    }
    Ok(())
}

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id.as_ref() {
        ITEM_SHOW => show_main(app),
        ITEM_CHECK => {
            let h = app.clone();
            tauri::async_runtime::spawn(async move {
                check(h, true).await;
            });
        }
        ITEM_UPDATE => {
            let h = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = apply_update(h).await {
                    eprintln!("updater: apply failed: {err}");
                }
            });
        }
        ITEM_CHANGE_SERVER => {
            show_main(app);
            if let Err(err) = connection::change_server(app.clone()) {
                eprintln!("change_server: {err}");
            }
        }
        ITEM_DISCONNECT => {
            show_main(app);
            if let Err(err) = connection::disconnect(app.clone()) {
                eprintln!("disconnect: {err}");
            }
        }
        ITEM_QUIT => {
            if let Some(flag) = app.try_state::<QuitFlag>() {
                flag.0.store(true, Ordering::SeqCst);
            }
            app.exit(0);
        }
        _ => {}
    }
}
