use std::sync::{Arc, Mutex};

use tauri::async_runtime::JoinHandle;
use tauri::image::Image;
use tauri::{AppHandle, Manager, UserAttentionType};
use log::{error, info};

use crate::tray::TRAY_ID;

fn alert_variant(src: &Image<'_>) -> Image<'static> {
    let w = src.width() as i32;
    let h = src.height() as i32;
    let mut pixels: Vec<u8> = src.rgba().to_vec();

    let smaller = w.min(h) as f32;
    let radius = (smaller * 0.45 / 2.0).round();
    let margin = (smaller * 0.04).max(1.0);
    let cx = w as f32 - radius - margin;
    let cy = h as f32 - radius - margin;

    for y in 0..h {
        for x in 0..w {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist < radius + 1.0 {
                let edge = (radius - dist).clamp(0.0, 1.0);
                let alpha = (255.0 * edge) as u16;
                let inv = 255 - alpha;
                let idx = ((y * w + x) * 4) as usize;
                pixels[idx]     = ((237u16 * alpha + pixels[idx]     as u16 * inv) / 255) as u8;
                pixels[idx + 1] = ((66u16  * alpha + pixels[idx + 1] as u16 * inv) / 255) as u8;
                pixels[idx + 2] = ((69u16  * alpha + pixels[idx + 2] as u16 * inv) / 255) as u8;
                pixels[idx + 3] = pixels[idx + 3].max(alpha as u8);
            }
        }
    }

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
    info!("tray_flash: invoked tray={tray} window={window}");

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
                Ok(()) => info!("tray_flash: alert icon applied"),
                Err(e) => error!("tray_flash: set_icon failed: {e}"),
            }
        }

        let app2 = app.clone();
        let state2 = Arc::clone(&*state);
        inner.task = Some(tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            let Ok(mut g) = state2.0.lock() else { return };
            if let Some(tray_handle) = app2.tray_by_id(TRAY_ID) {
                match tray_handle.set_icon(Some(g.normal.clone())) {
                    Ok(()) => info!("tray_flash: icon reverted"),
                    Err(e) => error!("tray_flash: revert set_icon failed: {e}"),
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
