mod commands;
mod listener;
mod shortcut;

use std::sync::{Arc, Mutex};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::UpdaterExt;

use crate::listener::ListenerState;

pub fn run() {
    let base_url = option_env!("APP_BASE_URL").unwrap_or("http://localhost:8080/");
    let url: tauri::Url = base_url.parse().expect("invalid APP_BASE_URL");

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_shortcut,
            commands::set_shortcut,
            commands::start_capture,
            commands::cancel_capture,
        ])
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Voice Hub")
                .inner_size(1440.0, 980.0)
                .min_inner_size(1100.0, 760.0)
                .resizable(true)
                .build()?;

            let handle = app.handle().clone();

            let initial = shortcut::load(&handle).or_else(|| Some(shortcut::InputBinding::default_combo()));
            let state = Arc::new(Mutex::new(ListenerState::new(initial)));
            app.manage(state.clone());

            listener::start(handle.clone(), state);

            tauri::async_runtime::spawn(async move {
                if let Err(err) = check_for_update(handle).await {
                    eprintln!("updater: {err}");
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn check_for_update(handle: tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let Some(update) = handle.updater()?.check().await? else {
        return Ok(());
    };

    update.download_and_install(|_, _| {}, || {}).await?;
    handle.restart();
}
