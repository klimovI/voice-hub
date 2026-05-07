use std::sync::{Arc, Mutex};

use tauri::async_runtime::JoinHandle;
use tauri::image::Image;
use tauri::{AppHandle, Manager};

use crate::tray::TRAY_ID;

fn red_tint(src: &Image<'_>, alpha: f32) -> Image<'static> {
    let pixels: Vec<u8> = src
        .rgba()
        .chunks_exact(4)
        .flat_map(|p| {
            let a = p[3] as f32 / 255.0;
            let r = (p[0] as f32 * (1.0 - alpha) + 255.0 * alpha).min(255.0) as u8;
            let g = (p[1] as f32 * (1.0 - alpha * a)).min(255.0) as u8;
            let b = (p[2] as f32 * (1.0 - alpha * a)).min(255.0) as u8;
            [r, g, b, p[3]]
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
        let alert = red_tint(&base, 0.55);
        Self(Mutex::new(Inner {
            normal: base,
            alert,
            task: None,
        }))
    }
}

pub fn flash(app: AppHandle) -> Result<(), String> {
    let state = app
        .try_state::<Arc<TrayFlashState>>()
        .ok_or_else(|| "TrayFlashState not managed".to_string())?;

    let mut inner = state.0.lock().map_err(|e| format!("lock: {e}"))?;

    if let Some(handle) = inner.task.take() {
        handle.abort();
    }

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_icon(Some(inner.alert.clone()))
            .map_err(|e| format!("set_icon: {e}"))?;
    }

    let app2 = app.clone();
    let state2 = Arc::clone(&*state);
    inner.task = Some(tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
        let Ok(mut g) = state2.0.lock() else { return };
        if let Some(tray) = app2.tray_by_id(TRAY_ID) {
            let _ = tray.set_icon(Some(g.normal.clone()));
        }
        g.task = None;
    }));

    Ok(())
}
