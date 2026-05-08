// Windows taskbar button icon swap.
//
// Tauri's Window::set_icon only updates ICON_SMALL (caption + Alt-Tab thumb).
// The taskbar button on Win10/11 looks at ICON_BIG via WM_SETICON AND the
// window class icon (GCLP_HICON); some shell builds prefer the class icon.
// We set both, save the original class icon on first activation, and restore
// it on revert.

#![cfg(target_os = "windows")]

use std::ffi::c_void;
use std::sync::OnceLock;

use log::warn;
use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateIconFromResourceEx, SendMessageW, SetClassLongPtrW, GCLP_HICON, ICON_BIG,
    LR_DEFAULTCOLOR, WM_SETICON,
};

static ALERT_PNG: &[u8] = include_bytes!("../icons/tray-alert.png");
static ALERT_HICON: OnceLock<usize> = OnceLock::new();
static ORIGINAL_CLASS_HICON: OnceLock<usize> = OnceLock::new();

fn load_alert_hicon() -> Option<usize> {
    // SAFETY: ALERT_PNG is a 'static slice with stable address/length for the
    // process lifetime. CreateIconFromResourceEx accepts a PNG-encoded icon
    // resource on Vista+. dwVer=0x00030000 is the documented version constant.
    let h = unsafe {
        CreateIconFromResourceEx(
            ALERT_PNG.as_ptr() as *mut u8,
            ALERT_PNG.len() as u32,
            1,
            0x00030000,
            0,
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
    // thread synchronously. SetClassLongPtrW sets the class big icon used by
    // the shell when ICON_BIG isn't honored. HICONs outlive both calls (cached).
    let prev_class = unsafe {
        SendMessageW(
            hwnd_raw as HWND,
            WM_SETICON,
            ICON_BIG as WPARAM,
            hicon as LPARAM,
        );
        SetClassLongPtrW(hwnd_raw as HWND, GCLP_HICON, hicon as isize)
    };
    let _ = ORIGINAL_CLASS_HICON.set(prev_class);
    warn!(
        "taskbar_icon: ICON_BIG + GCLP_HICON set hwnd={hwnd_raw:?} hicon={hicon:#x} prev_class={prev_class:#x}"
    );
}

pub fn clear(hwnd_raw: *mut c_void) {
    let orig = ORIGINAL_CLASS_HICON.get().copied().unwrap_or(0);
    // SAFETY: see set_alert. WM_SETICON lParam=0 reverts to the class default;
    // SetClassLongPtrW restores the original GCLP_HICON we captured on first
    // alert (0 if never set, which the shell treats as no class icon).
    unsafe {
        SendMessageW(hwnd_raw as HWND, WM_SETICON, ICON_BIG as WPARAM, 0);
        SetClassLongPtrW(hwnd_raw as HWND, GCLP_HICON, orig as isize);
    }
    warn!("taskbar_icon: ICON_BIG cleared, GCLP_HICON restored hwnd={hwnd_raw:?} orig={orig:#x}");
}
