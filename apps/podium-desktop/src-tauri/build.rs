fn main() {
    // The built-in Linear application's public client_id is injected at
    // compile time (TM-CRED-001); rebuild when it changes.
    println!("cargo:rerun-if-env-changed=SYMPHONY_LINEAR_CLIENT_ID");
    tauri_build::build()
}
