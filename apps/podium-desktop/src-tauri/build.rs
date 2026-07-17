fn main() {
    let attributes = tauri_build::Attributes::new().capabilities_path_pattern(if cfg!(feature = "e2e") {
        "./capabilities/e2e/*.json"
    } else {
        "./capabilities/default.json"
    });
    tauri_build::try_build(attributes).expect("failed to build Tauri application");
}
