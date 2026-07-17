use std::sync::Arc;
use symphony_podium_desktop::desktop_controller::DesktopController;
use symphony_podium_desktop::oauth_return::OAuthReturnRegistry;
use symphony_podium_desktop::repository_context::RepositoryContext;
use tauri::{Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
fn podium_client_request(
    controller: State<'_, Arc<DesktopController>>,
    frame: Vec<u8>,
) -> Result<Vec<u8>, String> {
    controller.client_request(&frame).map_err(|error| format!("{error:?}"))
}

#[tauri::command]
async fn select_repository_context(
    controller: State<'_, Arc<DesktopController>>,
) -> Result<Option<RepositoryContext>, String> {
    controller.inner().clone().select_repository().await.map_err(|error| format!("{error:?}"))
}

#[tauri::command]
fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://") || url.len() > 2048 {
        return Err("external_url_invalid".to_owned());
    }
    app.opener().open_url(url, None::<&str>).map_err(|_| "external_open_failed".to_owned())
}

fn main() {
    let app = tauri::Builder::default()
        .manage(Arc::new(OAuthReturnRegistry::default()))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            podium_client_request,
            select_repository_context,
            open_external_url
        ])
        .setup(|app| {
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            app.deep_link().register_all()?;

            let returns = app.state::<Arc<OAuthReturnRegistry>>().inner().clone();
            let controller = DesktopController::start(app.handle().clone())
                .map_err(|error| format!("desktop_controller_start_failed:{error:?}"))?;
            app.manage(controller.clone());
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    match returns.receive(url.as_str()) {
                        Ok(result) => {
                            if let Err(error) = controller.forward_oauth_return(result) {
                                eprintln!("OAuth callback relay failed: {error:?}");
                            }
                        }
                        Err(error) => {
                            eprintln!("OAuth callback rejected: {error:?}");
                        }
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Symphony Podium Desktop");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(controller) = handle.try_state::<Arc<DesktopController>>() {
                tauri::async_runtime::block_on(controller.shutdown());
            }
        }
    });
}
