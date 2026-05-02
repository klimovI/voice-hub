use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::UpdaterExt;

pub fn run() {
    let base_url = option_env!("APP_BASE_URL").unwrap_or("http://localhost:8080/");
    let url: tauri::Url = base_url.parse().expect("invalid APP_BASE_URL");

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Voice Hub")
                .inner_size(1440.0, 980.0)
                .min_inner_size(1100.0, 760.0)
                .resizable(true)
                .build()?;

            let handle = app.handle().clone();
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
