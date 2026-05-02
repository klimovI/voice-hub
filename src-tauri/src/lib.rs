mod commands;
mod listener;
mod shortcut;
mod tray;
mod updater;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::listener::ListenerState;

pub struct QuitFlag(pub AtomicBool);

pub fn run() {
    let base_url = option_env!("APP_BASE_URL").unwrap_or("http://localhost:8080/");
    let url: tauri::Url = base_url.parse().expect("invalid APP_BASE_URL");

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_shortcut,
            commands::set_shortcut,
            commands::clear_shortcut,
            commands::start_capture,
            commands::stop_capture,
            commands::cancel_capture,
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

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Voice Hub")
                .inner_size(1440.0, 980.0)
                .min_inner_size(1100.0, 760.0)
                .resizable(true)
                .build()?;

            tray::init(app)?;

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
