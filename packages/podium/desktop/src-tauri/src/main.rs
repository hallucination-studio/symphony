mod commands;
pub mod conductor_process;
mod oauth;
mod podium_process;
mod private_ipc;
mod process_state;
mod shutdown;
mod supervisor;

use std::sync::{Arc, Mutex};

fn main() {
    if oauth::fixed_manifest().is_err() {
        fail("linear_client_id_missing", "linear_client_id_missing");
    }
    let process = Arc::new(Mutex::new(None));
    let startup_error = Arc::new(Mutex::new(None));
    let setup_process = Arc::clone(&process);
    let setup_error = Arc::clone(&startup_error);
    let app = tauri::Builder::default()
        .manage(Arc::clone(&process))
        .invoke_handler(tauri::generate_handler![commands::podium_command])
        .setup(move |_| {
            let child = podium_process::PodiumProcess::start().map_err(|error| {
                *setup_error.lock().expect("podium startup error lock poisoned") =
                    Some(error.clone());
                std::io::Error::other(error)
            })?;
            *setup_process.lock().expect("podium process lock poisoned") = Some(child);
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(_) => {
            let error = startup_error.lock().expect("podium startup error lock poisoned").take();
            match error.and_then(podium_process::observed_lifecycle_failure) {
                Some(observation) => {
                    observation.log("podium_lifecycle_failed");
                    std::process::exit(1);
                }
                None => fail("podium_sidecar_start_failed", "sidecar_start_failed"),
            }
        }
    };
    app.run(move |_app, event| {
        if matches!(event, tauri::RunEvent::MainEventsCleared) {
            let exited = process
                .lock()
                .expect("podium process lock poisoned")
                .as_mut()
                .is_some_and(|child| child.exited().unwrap_or(true));
            if exited {
                fail("podium_sidecar_exited", "sidecar_process_exited");
            }
        }
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            if let Some(mut child) = process.lock().expect("podium process lock poisoned").take() {
                child.shutdown();
            }
        }
    });
}

fn fail(error_code: &str, sanitized_reason: &str) -> ! {
    eprintln!(
        "event=podium_sidecar_failed error_type=process_exit error_code={error_code} \
         sanitized_reason={sanitized_reason} action_required=true retryable=false \
         next_action=restart_desktop"
    );
    std::process::exit(1);
}
