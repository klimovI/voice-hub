use std::sync::{Arc, Mutex};

use tauri::image::Image;
use tauri::{AppHandle, Manager, UserAttentionType};
use log::{error, info, warn};

use crate::tray::TRAY_ID;

struct Inner {
    normal: Image<'static>,
    alert: Image<'static>,
    tray_active: bool,
    window_icon_active: bool,
}

pub struct TrayFlashState(Mutex<Inner>);

impl TrayFlashState {
    pub fn new(normal: Image<'static>, alert: Image<'static>) -> Self {
        Self(Mutex::new(Inner {
            normal,
            alert,
            tray_active: false,
            window_icon_active: false,
        }))
    }
}

pub fn flash_attention(app: AppHandle, tray: bool, window: bool) -> Result<(), String> {
    info!("tray_flash: invoked tray={tray} window={window}");

    if !tray && !window {
        return Ok(());
    }

    let main = app.get_webview_window("main");
    let focused = match main.as_ref() {
        Some(w) => match w.is_focused() {
            Ok(f) => f,
            Err(e) => {
                warn!("tray_flash: is_focused failed, assuming unfocused: {e}");
                false
            }
        },
        None => false,
    };

    if focused {
        info!("tray_flash: skipped, window focused");
        return Ok(());
    }

    let state = app
        .try_state::<Arc<TrayFlashState>>()
        .ok_or_else(|| "TrayFlashState not managed".to_string())?;
    let mut inner = state.0.lock().map_err(|e| format!("lock: {e}"))?;

    if tray {
        if let Some(tray_handle) = app.tray_by_id(TRAY_ID) {
            match tray_handle.set_icon(Some(inner.alert.clone())) {
                Ok(()) => {
                    info!("tray_flash: alert tray icon applied");
                    inner.tray_active = true;
                }
                Err(e) => error!("tray_flash: tray set_icon failed: {e}"),
            }
        }
    }

    if window {
        if let Some(w) = main.as_ref() {
            match w.set_icon(inner.alert.clone()) {
                Ok(()) => {
                    info!("tray_flash: alert window icon applied");
                    inner.window_icon_active = true;
                }
                Err(e) => error!("tray_flash: window set_icon failed: {e}"),
            }
            #[cfg(target_os = "windows")]
            match w.hwnd() {
                Ok(hwnd) => crate::taskbar_icon::set_alert(hwnd.0),
                Err(e) => warn!("tray_flash: hwnd() failed: {e}"),
            }
            if let Err(e) = w.request_user_attention(Some(UserAttentionType::Informational)) {
                warn!("tray_flash: request_user_attention failed: {e}");
            }
        }
    }

    Ok(())
}

pub fn revert_if_active(app: &AppHandle) -> Result<(), String> {
    let state = app
        .try_state::<Arc<TrayFlashState>>()
        .ok_or_else(|| "TrayFlashState not managed".to_string())?;

    let mut inner = state.0.lock().map_err(|e| format!("lock: {e}"))?;

    if !inner.tray_active && !inner.window_icon_active {
        return Ok(());
    }

    if inner.tray_active {
        if let Some(tray_handle) = app.tray_by_id(TRAY_ID) {
            match tray_handle.set_icon(Some(inner.normal.clone())) {
                Ok(()) => info!("tray_flash: tray icon reverted on focus"),
                Err(e) => error!("tray_flash: tray revert set_icon failed: {e}"),
            }
        }
        inner.tray_active = false;
    }

    if inner.window_icon_active {
        if let Some(w) = app.get_webview_window("main") {
            match w.set_icon(inner.normal.clone()) {
                Ok(()) => info!("tray_flash: window icon reverted on focus"),
                Err(e) => error!("tray_flash: window revert set_icon failed: {e}"),
            }
            #[cfg(target_os = "windows")]
            match w.hwnd() {
                Ok(hwnd) => crate::taskbar_icon::clear(hwnd.0),
                Err(e) => warn!("tray_flash: hwnd() failed on revert: {e}"),
            }
        }
        inner.window_icon_active = false;
    }

    Ok(())
}
