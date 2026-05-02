mod commands;
mod connection;
mod listener;
mod shortcut;
mod updater;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::listener::ListenerState;

pub struct QuitFlag(pub AtomicBool);

pub fn run() {
    // Pick the initial URL from the saved host (if any). With no host, load
    // the local connect.html screen — the user enters their server there.
    let initial_url = match connection::load_host() {
        Some(host) => match connection::normalize_host(&host) {
            Ok(url) => WebviewUrl::External(url),
            Err(_) => WebviewUrl::App("connect.html".into()),
        },
        None => WebviewUrl::App("connect.html".into()),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_shortcut,
            commands::set_shortcut,
            commands::clear_shortcut,
            commands::start_capture,
            commands::cancel_capture,
            connection::get_state,
            connection::set_host,
            connection::disconnect,
            connection::change_server,
            updater::check_for_update,
            updater::apply_update,
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::Focused(true) => {
                    let app = window.app_handle().clone();
                    tauri::async_runtime::spawn(async move {
                        updater::check_on_focus(app).await;
                    });
                }
                WindowEvent::CloseRequested { api, .. } => {
                    let flag = window.state::<QuitFlag>();
                    if !flag.0.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                _ => {}
            }
        })
        .setup(move |app| {
            app.manage(QuitFlag(AtomicBool::new(false)));

            WebviewWindowBuilder::new(app, "main", initial_url)
                .title("Voice Hub")
                .inner_size(1440.0, 980.0)
                .min_inner_size(1100.0, 760.0)
                .resizable(true)
                .build()?;

            let handle = app.handle().clone();

            // First run (no config file) → seed default and persist.
            // Existing file (even with `null`) → respect user's choice.
            let initial = match shortcut::load(&handle) {
                Some(opt) => opt,
                None => {
                    let default = shortcut::InputBinding::default_combo();
                    let _ = shortcut::save(&handle, Some(&default));
                    Some(default)
                }
            };
            let state = Arc::new(Mutex::new(ListenerState::new(initial)));
            app.manage(state.clone());

            listener::start(handle.clone(), state);

            updater::init(&handle)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
