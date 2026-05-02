use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};

const INTERVAL: Duration = Duration::from_secs(60 * 60);
const FOCUS_THROTTLE: Duration = Duration::from_secs(15 * 60);

const TRAY_ID: &str = "main";
const ITEM_UPDATE: &str = "update_apply";
const ITEM_CHECK: &str = "update_check";
const ITEM_SHOW: &str = "show_window";
const ITEM_QUIT: &str = "quit";

pub struct UpdaterState {
    last_checked: Option<Instant>,
    pending: Option<Update>,
}

impl UpdaterState {
    fn new() -> Self {
        Self {
            last_checked: None,
            pending: None,
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
    if !force {
        let state = match app.try_state::<SharedUpdater>() {
            Some(s) => s,
            None => return,
        };
        if let Ok(s) = state.lock() {
            if let Some(prev) = s.last_checked {
                if prev.elapsed() < FOCUS_THROTTLE {
                    return;
                }
            }
        }
    }

    {
        let state = match app.try_state::<SharedUpdater>() {
            Some(s) => s,
            None => return,
        };
        if let Ok(mut s) = state.lock() {
            s.last_checked = Some(Instant::now());
        }
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
    if let Some(state) = app.try_state::<SharedUpdater>() {
        if let Ok(mut s) = state.lock() {
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
    let update = {
        let state = app
            .try_state::<SharedUpdater>()
            .ok_or_else(|| "updater state missing".to_string())?;
        let mut s = state.lock().map_err(|e| format!("lock: {e}"))?;
        s.pending.take()
    };

    let update = match update {
        Some(u) => u,
        None => return Err("no pending update".to_string()),
    };

    update
        .download_and_install(|_, _| {}, || {})
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
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

fn base_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let show = MenuItem::with_id(app, ITEM_SHOW, "Открыть Voice Hub", true, None::<&str>)?;
    let check = MenuItem::with_id(app, ITEM_CHECK, "Проверить обновления", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, ITEM_QUIT, "Выход", true, None::<&str>)?;
    MenuBuilder::new(app)
        .item(&show)
        .item(&check)
        .item(&sep)
        .item(&quit)
        .build()
}

fn update_tray_for_available(app: &AppHandle, version: &str) -> tauri::Result<()> {
    let label = format!("Установить v{version}");
    let apply = MenuItem::with_id(app, ITEM_UPDATE, &label, true, None::<&str>)?;
    let show = MenuItem::with_id(app, ITEM_SHOW, "Открыть Voice Hub", true, None::<&str>)?;
    let check = MenuItem::with_id(app, ITEM_CHECK, "Проверить обновления", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, ITEM_QUIT, "Выход", true, None::<&str>)?;
    let menu = MenuBuilder::new(app)
        .item(&apply)
        .item(&sep1)
        .item(&show)
        .item(&check)
        .item(&sep2)
        .item(&quit)
        .build()?;

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))?;
        tray.set_tooltip(Some(format!("Voice Hub — доступна v{version}")))?;
    }
    Ok(())
}

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id.as_ref() {
        ITEM_SHOW => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
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
        ITEM_QUIT => {
            app.exit(0);
        }
        _ => {}
    }
}
