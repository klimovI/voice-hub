use std::sync::{Arc, Mutex};

use tauri::image::Image;
use tauri::{AppHandle, Manager, UserAttentionType};
use log::{error, info, warn};

use crate::tray::TRAY_ID;

struct Inner {
    normal: Image<'static>,
    alert: Image<'static>,
    active: bool,
}

pub struct TrayFlashState(Mutex<Inner>);

impl TrayFlashState {
    pub fn new(normal: Image<'static>, alert: Image<'static>) -> Self {
        Self(Mutex::new(Inner {
            normal,
            alert,
            active: false,
        }))
    }
}

pub fn flash_attention(app: AppHandle, tray: bool, window: bool) -> Result<(), String> {
    info!("tray_flash: invoked tray={tray} window={window}");

    if !tray && !window {
        return Ok(());
    }

    if tray {
        let focused = match app.get_webview_window("main") {
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
        } else {
            let state = app
                .try_state::<Arc<TrayFlashState>>()
                .ok_or_else(|| "TrayFlashState not managed".to_string())?;

            let mut inner = state.0.lock().map_err(|e| format!("lock: {e}"))?;

            if let Some(tray_handle) = app.tray_by_id(TRAY_ID) {
                match tray_handle.set_icon(Some(inner.alert.clone())) {
                    Ok(()) => info!("tray_flash: alert icon applied"),
                    Err(e) => error!("tray_flash: set_icon failed: {e}"),
                }
            }
            inner.active = true;
        }
    }

    if window {
        if let Some(w) = app.get_webview_window("main") {
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

    if !inner.active {
        return Ok(());
    }

    if let Some(tray_handle) = app.tray_by_id(TRAY_ID) {
        match tray_handle.set_icon(Some(inner.normal.clone())) {
            Ok(()) => info!("tray_flash: icon reverted on focus"),
            Err(e) => error!("tray_flash: revert set_icon failed: {e}"),
        }
    }
    inner.active = false;

    Ok(())
}
