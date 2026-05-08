// Windows taskbar button icon swap via WM_SETICON ICON_BIG.
// Tauri's Window::set_icon only updates ICON_SMALL (caption + Alt-Tab thumb);
// the taskbar button uses ICON_BIG, which we set directly here.

#![cfg(target_os = "windows")]

use std::ffi::c_void;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

use log::{debug, error, warn};
use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    LoadImageW, SendMessageW, ICON_BIG, IMAGE_ICON, LR_DEFAULTSIZE, LR_LOADFROMFILE, WM_SETICON,
};

static ALERT_PNG: &[u8] = include_bytes!("../icons/tray-alert.png");
static ALERT_HICON: OnceLock<usize> = OnceLock::new();

fn png_dims(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() < 24 || &png[0..8] != b"\x89PNG\r\n\x1a\n" || &png[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(png[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(png[20..24].try_into().ok()?);
    Some((w, h))
}

fn wrap_png_as_ico(png: &[u8]) -> Option<Vec<u8>> {
    let (w, h) = png_dims(png)?;
    let mut out = Vec::with_capacity(22 + png.len());
    out.extend_from_slice(&[0, 0, 1, 0, 1, 0]);
    out.push(if w >= 256 { 0 } else { w as u8 });
    out.push(if h >= 256 { 0 } else { h as u8 });
    out.push(0);
    out.push(0);
    out.extend_from_slice(&[1, 0, 32, 0]);
    out.extend_from_slice(&(png.len() as u32).to_le_bytes());
    out.extend_from_slice(&22u32.to_le_bytes());
    out.extend_from_slice(png);
    Some(out)
}

fn load_alert_hicon() -> Option<usize> {
    let ico = wrap_png_as_ico(ALERT_PNG)?;
    let mut path: PathBuf = std::env::temp_dir();
    path.push("voice-hub-taskbar-alert.ico");
    if let Err(e) = std::fs::File::create(&path).and_then(|mut f| f.write_all(&ico)) {
        error!("taskbar_icon: temp ico write failed: {e}");
        return None;
    }
    let wide: Vec<u16> = path
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `wide` is a NUL-terminated UTF-16 string with a valid lifetime
    // for the duration of the call; null HINSTANCE is allowed for LR_LOADFROMFILE.
    let h = unsafe {
        LoadImageW(
            std::ptr::null_mut(),
            wide.as_ptr(),
            IMAGE_ICON,
            0,
            0,
            LR_LOADFROMFILE | LR_DEFAULTSIZE,
        )
    };
    if h.is_null() {
        error!("taskbar_icon: LoadImageW returned NULL");
        return None;
    }
    Some(h as usize)
}

pub fn set_alert(hwnd_raw: *mut c_void) {
    let hicon = *ALERT_HICON.get_or_init(|| load_alert_hicon().unwrap_or(0));
    if hicon == 0 {
        warn!("taskbar_icon: alert HICON unavailable");
        return;
    }
    // SAFETY: hwnd_raw is the HWND returned by Tauri's `Window::hwnd()`, valid
    // for the lifetime of the main window. SendMessageW marshals to the UI
    // thread synchronously; HICON outlives the call (process-static cache).
    unsafe {
        SendMessageW(
            hwnd_raw as HWND,
            WM_SETICON,
            ICON_BIG as WPARAM,
            hicon as LPARAM,
        );
    }
    debug!("taskbar_icon: ICON_BIG set to alert");
}

pub fn clear(hwnd_raw: *mut c_void) {
    // SAFETY: see set_alert. lParam=0 instructs Windows to revert to the
    // class-default icon (the .exe-bundled resource).
    unsafe {
        SendMessageW(hwnd_raw as HWND, WM_SETICON, ICON_BIG as WPARAM, 0);
    }
    debug!("taskbar_icon: ICON_BIG cleared");
}
