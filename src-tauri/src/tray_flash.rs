use std::sync::{Arc, Mutex};

use tauri::async_runtime::JoinHandle;
use tauri::image::Image;
use tauri::{AppHandle, Manager, UserAttentionType};

use crate::tray::TRAY_ID;

fn alert_variant(src: &Image<'_>) -> Image<'static> {
    let pixels: Vec<u8> = src
        .rgba()
        .chunks_exact(4)
        .flat_map(|p| {
            if p[3] == 0 {
                [0, 0, 0, 0]
            } else {
                [255, 30, 30, p[3]]
            }
        })
        .collect();
    Image::new_owned(pixels, src.width(), src.height())
}

struct Inner {
    normal: Image<'static>,
    alert: Image<'static>,
    task: Option<JoinHandle<()>>,
}

pub struct TrayFlashState(Mutex<Inner>);

impl TrayFlashState {
    pub fn new(base: Image<'static>) -> Self {
        let alert = alert_variant(&base);
        Self(Mutex::new(Inner {
            normal: base,
            alert,
            task: None,
        }))
    }
}

pub fn flash_attention(app: AppHandle, tray: bool, window: bool) -> Result<(), String> {
    eprintln!("tray_flash: invoked tray={tray} window={window}");

    if !tray && !window {
        return Ok(());
    }

    if tray {
        let state = app
            .try_state::<Arc<TrayFlashState>>()
            .ok_or_else(|| "TrayFlashState not managed".to_string())?;

        let mut inner = state.0.lock().map_err(|e| format!("lock: {e}"))?;

        if let Some(handle) = inner.task.take() {
            handle.abort();
        }

        if let Some(tray_handle) = app.tray_by_id(TRAY_ID) {
            match tray_handle.set_icon(Some(inner.alert.clone())) {
                Ok(()) => eprintln!("tray_flash: alert icon applied"),
                Err(e) => eprintln!("tray_flash: set_icon failed: {e}"),
            }
        }

        let app2 = app.clone();
        let state2 = Arc::clone(&*state);
        inner.task = Some(tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            let Ok(mut g) = state2.0.lock() else { return };
            if let Some(tray_handle) = app2.tray_by_id(TRAY_ID) {
                match tray_handle.set_icon(Some(g.normal.clone())) {
                    Ok(()) => eprintln!("tray_flash: icon reverted"),
                    Err(e) => eprintln!("tray_flash: revert set_icon failed: {e}"),
                }
            }
            g.task = None;
        }));
    }

    if window {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.request_user_attention(Some(UserAttentionType::Informational));
        }
    }

    Ok(())
}
