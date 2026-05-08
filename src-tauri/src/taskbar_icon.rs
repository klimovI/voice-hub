// Windows taskbar button icon swap via WM_SETICON ICON_BIG.
// Tauri's Window::set_icon only updates ICON_SMALL (caption + Alt-Tab thumb);
// the taskbar button uses ICON_BIG, which we set directly here.

#![cfg(target_os = "windows")]

use std::ffi::c_void;
use std::sync::OnceLock;

use log::warn;
use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateIconFromResourceEx, SendMessageW, ICON_BIG, LR_DEFAULTCOLOR, WM_SETICON,
};

static ALERT_PNG: &[u8] = include_bytes!("../icons/tray-alert.png");
static ALERT_HICON: OnceLock<usize> = OnceLock::new();

fn load_alert_hicon() -> Option<usize> {
    // SAFETY: ALERT_PNG is a 'static slice with stable address/length for the
    // process lifetime. CreateIconFromResourceEx accepts a PNG-encoded icon
    // resource on Vista+. dwVer=0x00030000 is the documented version constant.
    let h = unsafe {
        CreateIconFromResourceEx(
            ALERT_PNG.as_ptr() as *mut u8,
            ALERT_PNG.len() as u32,
            1, // fIcon = TRUE
            0x00030000,
            0, // cxDesired = 0 → default (SM_CXICON)
            0,
            LR_DEFAULTCOLOR,
        )
    };
    if h.is_null() {
        let err = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        warn!("taskbar_icon: CreateIconFromResourceEx returned NULL, GetLastError={err}");
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
    warn!("taskbar_icon: ICON_BIG set to alert hwnd={hwnd_raw:?} hicon={hicon:#x}");
}

pub fn clear(hwnd_raw: *mut c_void) {
    // SAFETY: see set_alert. lParam=0 instructs Windows to revert to the
    // class-default icon (the .exe-bundled resource).
    unsafe {
        SendMessageW(hwnd_raw as HWND, WM_SETICON, ICON_BIG as WPARAM, 0);
    }
    warn!("taskbar_icon: ICON_BIG cleared hwnd={hwnd_raw:?}");
}
