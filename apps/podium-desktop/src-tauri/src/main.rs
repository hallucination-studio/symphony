use std::sync::Arc;
use symphony_podium_desktop::oauth_return::OAuthReturnRegistry;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

fn main() {
    tauri::Builder::default()
        .manage(Arc::new(OAuthReturnRegistry::default()))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            app.deep_link().register_all()?;

            let returns = app.state::<Arc<OAuthReturnRegistry>>().inner().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Err(error) = returns.receive_for_backend(url.as_str()) {
                        eprintln!("OAuth callback rejected: {error:?}");
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Symphony Podium Desktop");
}
