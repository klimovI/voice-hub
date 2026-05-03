// Tray icon construction and menu event dispatch.
//
// Single source of truth for menu items. `build_menu` covers both the idle
// state (no pending update) and the update-available state — callers pass the
// optional update version and this function adds the "Install" item when set.

use std::sync::atomic::Ordering;

use tauri::menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, Wry};

use crate::connection;
use crate::updater;
use crate::QuitFlag;

pub const TRAY_ID: &str = "main";

const ITEM_UPDATE: &str = "update_apply";
const ITEM_CHECK: &str = "update_check";
const ITEM_SHOW: &str = "show_window";
const ITEM_CHANGE_SERVER: &str = "change_server";
const ITEM_DISCONNECT: &str = "disconnect";
const ITEM_QUIT: &str = "quit";

/// Build the tray menu. When `update_version` is `Some`, an "Install vX.Y.Z"
/// item appears at the top separated from the rest. `connected` controls
/// whether the "Disconnect" item is enabled; callers must pass `load_host().is_some()`.
pub fn build_menu(
    app: &AppHandle,
    update_version: Option<&str>,
    connected: bool,
) -> tauri::Result<Menu<Wry>> {
    let show = MenuItem::with_id(app, ITEM_SHOW, "Show Voice Hub", true, None::<&str>)?;
    let check = MenuItem::with_id(app, ITEM_CHECK, "Check for updates", true, None::<&str>)?;
    let change = MenuItem::with_id(app, ITEM_CHANGE_SERVER, "Change server", true, None::<&str>)?;
    let disconnect =
        MenuItem::with_id(app, ITEM_DISCONNECT, "Disconnect", connected, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, ITEM_QUIT, "Quit", true, None::<&str>)?;

    let mut builder = MenuBuilder::new(app);

    if let Some(version) = update_version {
        let label = format!("Install v{version}");
        let apply = MenuItem::with_id(app, ITEM_UPDATE, &label, true, None::<&str>)?;
        let sep0 = PredefinedMenuItem::separator(app)?;
        builder = builder.item(&apply).item(&sep0);
    }

    builder
        .item(&show)
        .item(&check)
        .item(&sep1)
        .item(&change)
        .item(&disconnect)
        .item(&sep2)
        .item(&quit)
        .build()
}

/// Construct the tray icon and attach event handlers. Called once at startup.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app, None, connection::load_host().is_some())?;
    // default_window_icon() is None only when no icon is configured in
    // tauri.conf.json. Voice Hub always ships with icons (icons/32x32.png
    // etc.), so None is unreachable in a correctly-built package.
    let icon = app
        .default_window_icon()
        .cloned()
        .unwrap_or_else(|| unreachable!("tauri.conf.json must declare at least one icon"));
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
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

/// Replace the tray menu and tooltip to reflect an available update.
pub fn set_update_available(app: &AppHandle, version: &str) -> tauri::Result<()> {
    let menu = build_menu(app, Some(version), connection::load_host().is_some())?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))?;
        tray.set_tooltip(Some(format!("Voice Hub — v{version} available")))?;
    }
    Ok(())
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id.as_ref() {
        ITEM_SHOW => show_main(app),
        ITEM_CHECK => {
            let h = app.clone();
            tauri::async_runtime::spawn(async move {
                updater::check_forced(h).await;
            });
        }
        ITEM_UPDATE => {
            let h = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = updater::apply_update(h).await {
                    log::error!("updater: apply failed: {err}");
                }
            });
        }
        ITEM_CHANGE_SERVER => {
            show_main(app);
            if let Err(err) = connection::change_server(app.clone()) {
                log::error!("change_server: {err}");
            }
        }
        ITEM_DISCONNECT => {
            show_main(app);
            if let Err(err) = connection::disconnect(app.clone()) {
                log::error!("disconnect: {err}");
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
