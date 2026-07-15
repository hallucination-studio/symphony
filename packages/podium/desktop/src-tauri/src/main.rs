mod oauth;
mod podium_process;
#[cfg(test)]
mod private_ipc;

use std::sync::{Arc, Mutex};

fn main() {
    if oauth::fixed_manifest().is_err() {
        fail("linear_client_id_missing", "linear_client_id_missing");
    }
    let process = Arc::new(Mutex::new(None));
    let setup_process = Arc::clone(&process);
    let app = tauri::Builder::default()
        .setup(move |_| {
            let child = podium_process::PodiumProcess::start()
                .map_err(|error| std::io::Error::other(error))?;
            *setup_process.lock().expect("podium process lock poisoned") = Some(child);
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(_) => fail("podium_sidecar_start_failed", "sidecar_start_failed"),
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
         sanitized_reason={sanitized_reason} action_required=restart_desktop retryable=false \
         next_action=restart_desktop"
    );
    std::process::exit(1);
}
