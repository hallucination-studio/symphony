use serde_json::Value;
use std::{env, fs, path::Path};
use symphony_contracts::decode_contract;

fn sorted_files(directory: &str) -> Result<Vec<std::path::PathBuf>, String> {
    let mut files = fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .map(|entry| entry.map(|item| item.path()).map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    files.sort();
    Ok(files)
}

fn read_fixture(path: &Path) -> Result<Value, String> {
    let source = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&source).map_err(|error| error.to_string())
}

fn validate_fixture_directories(valid_dir: &str, invalid_dir: &str) -> Result<(), String> {
    for path in sorted_files(valid_dir)? {
        let fixture = read_fixture(&path)?;
        let reference = fixture["schema"].as_str().ok_or("fixture schema")?;
        decode_contract(reference, &fixture["value"])
            .map_err(|errors| format!("{}: {}", path.display(), errors.join("\n")))?;
    }
    for path in sorted_files(invalid_dir)? {
        let fixture = read_fixture(&path)?;
        let reference = fixture["schema"].as_str().ok_or("fixture schema")?;
        if decode_contract(reference, &fixture["value"]).is_ok() {
            return Err(format!("invalid fixture was accepted: {}", path.display()));
        }
    }
    Ok(())
}

fn main() {
    let arguments: Vec<String> = env::args().collect();
    if let Err(error) = validate_fixture_directories(&arguments[1], &arguments[2]) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
