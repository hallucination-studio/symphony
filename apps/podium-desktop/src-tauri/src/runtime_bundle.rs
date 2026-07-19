use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub enum RuntimeBundleError {
    ManifestInvalid,
    PlatformMismatch,
    ArchitectureMismatch,
    ProtocolMismatch,
    DigestMismatch,
    FileInvalid,
    ModeInvalid,
    SwitchFailed,
    CurrentInvalid,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeBundleManifest {
    product_version: String,
    protocol_version: String,
    platform: String,
    architecture: String,
    payload_digest: String,
    files: Vec<RuntimeBundleFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeBundleFile {
    path: String,
    digest: String,
    executable: bool,
}

pub struct RuntimeBundleStore {
    root: PathBuf,
    protocol_version: String,
}

impl RuntimeBundleStore {
    pub fn new(root: PathBuf, protocol_version: &str) -> Self {
        Self { root, protocol_version: protocol_version.to_owned() }
    }

    pub fn activate(&self, candidate: &Path) -> Result<String, RuntimeBundleError> {
        let manifest = self.verify(candidate)?;
        fs::create_dir_all(&self.root).map_err(|_| RuntimeBundleError::SwitchFailed)?;
        let next = self.root.join("current.next");
        if next.exists() || next.is_symlink() {
            fs::remove_file(&next).map_err(|_| RuntimeBundleError::SwitchFailed)?;
        }
        symlink(candidate, &next).map_err(|_| RuntimeBundleError::SwitchFailed)?;
        fs::rename(&next, self.root.join("current")).map_err(|_| {
            let _ = fs::remove_file(&next);
            RuntimeBundleError::SwitchFailed
        })?;
        Ok(manifest.payload_digest)
    }

    pub fn current_executable(&self, name: &str) -> Result<PathBuf, RuntimeBundleError> {
        if !safe_relative_path(name) {
            return Err(RuntimeBundleError::CurrentInvalid);
        }
        let current = self.root.join("current");
        let target = fs::canonicalize(current).map_err(|_| RuntimeBundleError::CurrentInvalid)?;
        self.verify(&target)?;
        let executable = target.join(name);
        let metadata = fs::metadata(&executable).map_err(|_| RuntimeBundleError::CurrentInvalid)?;
        if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
            return Err(RuntimeBundleError::CurrentInvalid);
        }
        Ok(executable)
    }

    fn verify(&self, candidate: &Path) -> Result<RuntimeBundleManifest, RuntimeBundleError> {
        let bytes = fs::read(candidate.join("manifest.json"))
            .map_err(|_| RuntimeBundleError::ManifestInvalid)?;
        let manifest: RuntimeBundleManifest =
            serde_json::from_slice(&bytes).map_err(|_| RuntimeBundleError::ManifestInvalid)?;
        if manifest.product_version.is_empty()
            || manifest.files.is_empty()
            || manifest.files.len() > 64
            || !sha256(&manifest.payload_digest)
        {
            return Err(RuntimeBundleError::ManifestInvalid);
        }
        if manifest.platform != std::env::consts::OS {
            return Err(RuntimeBundleError::PlatformMismatch);
        }
        if manifest.architecture != std::env::consts::ARCH {
            return Err(RuntimeBundleError::ArchitectureMismatch);
        }
        if manifest.protocol_version != self.protocol_version {
            return Err(RuntimeBundleError::ProtocolMismatch);
        }
        if candidate.file_name().and_then(|value| value.to_str())
            != Some(manifest.payload_digest.as_str())
        {
            return Err(RuntimeBundleError::DigestMismatch);
        }
        let mut records = Vec::with_capacity(manifest.files.len());
        for file in &manifest.files {
            if !safe_relative_path(&file.path) || !sha256(&file.digest) {
                return Err(RuntimeBundleError::FileInvalid);
            }
            let path = candidate.join(&file.path);
            let metadata =
                fs::symlink_metadata(&path).map_err(|_| RuntimeBundleError::FileInvalid)?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(RuntimeBundleError::FileInvalid);
            }
            let executable = metadata.permissions().mode() & 0o111 != 0;
            if executable != file.executable {
                return Err(RuntimeBundleError::ModeInvalid);
            }
            let content = fs::read(&path).map_err(|_| RuntimeBundleError::FileInvalid)?;
            if hex::encode(Sha256::digest(content)) != file.digest {
                return Err(RuntimeBundleError::DigestMismatch);
            }
            records.push(format!("{}\0{}\0{}\n", file.path, file.digest, file.executable));
        }
        records.sort();
        if hex::encode(Sha256::digest(records.concat().as_bytes())) != manifest.payload_digest {
            return Err(RuntimeBundleError::DigestMismatch);
        }
        Ok(manifest)
    }
}

fn safe_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !value.is_empty()
        && !path.is_absolute()
        && path.components().all(|part| matches!(part, Component::Normal(_)))
}

fn sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn switches_verified_bundles_and_keeps_previous_on_validation_failure() {
        let root = temporary("switch");
        let first = bundle(&root, b"first");
        let store = RuntimeBundleStore::new(root.clone(), "1");
        store.activate(&first).unwrap();
        assert_eq!(fs::read(store.current_executable("conductor").unwrap()).unwrap(), b"first");

        let invalid = bundle(&root, b"second");
        fs::write(invalid.join("conductor"), b"tampered").unwrap();
        assert_eq!(store.activate(&invalid), Err(RuntimeBundleError::DigestMismatch));
        assert_eq!(fs::read(store.current_executable("conductor").unwrap()).unwrap(), b"first");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_wrong_platform_protocol_and_executable_mode() {
        let root = temporary("invalid");
        let candidate = bundle(&root, b"payload");
        let manifest_path = candidate.join("manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest["platform"] = json!("not-this-platform");
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert_eq!(
            RuntimeBundleStore::new(root.clone(), "1").activate(&candidate),
            Err(RuntimeBundleError::PlatformMismatch)
        );

        manifest["platform"] = json!(std::env::consts::OS);
        manifest["architecture"] = json!("not-this-architecture");
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert_eq!(
            RuntimeBundleStore::new(root.clone(), "1").activate(&candidate),
            Err(RuntimeBundleError::ArchitectureMismatch)
        );

        manifest["architecture"] = json!(std::env::consts::ARCH);
        manifest["protocol_version"] = json!("2");
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert_eq!(
            RuntimeBundleStore::new(root.clone(), "1").activate(&candidate),
            Err(RuntimeBundleError::ProtocolMismatch)
        );

        manifest["protocol_version"] = json!("1");
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let mut permissions = fs::metadata(candidate.join("conductor")).unwrap().permissions();
        permissions.set_mode(0o644);
        fs::set_permissions(candidate.join("conductor"), permissions).unwrap();
        assert_eq!(
            RuntimeBundleStore::new(root.clone(), "1").activate(&candidate),
            Err(RuntimeBundleError::ModeInvalid)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_pointer_switch_preserves_the_previous_runnable_bundle() {
        let root = temporary("pointer-failure");
        let first = bundle(&root, b"first");
        let second = bundle(&root, b"second");
        let store = RuntimeBundleStore::new(root.clone(), "1");
        store.activate(&first).unwrap();
        fs::create_dir(root.join("current.next")).unwrap();

        assert_eq!(store.activate(&second), Err(RuntimeBundleError::SwitchFailed));
        assert_eq!(fs::read(store.current_executable("conductor").unwrap()).unwrap(), b"first");
        fs::remove_dir_all(root).unwrap();
    }

    fn bundle(root: &Path, content: &[u8]) -> PathBuf {
        fs::create_dir_all(root).unwrap();
        let file_digest = hex::encode(Sha256::digest(content));
        let record = format!("conductor\0{file_digest}\0true\n");
        let payload_digest = hex::encode(Sha256::digest(record.as_bytes()));
        let candidate = root.join(&payload_digest);
        fs::create_dir(&candidate).unwrap();
        let path = candidate.join("conductor");
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(content).unwrap();
        let mut permissions = file.metadata().unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).unwrap();
        fs::write(
            candidate.join("manifest.json"),
            serde_json::to_vec(&json!({
                "product_version": "1.0.0", "protocol_version": "1",
                "platform": std::env::consts::OS, "architecture": std::env::consts::ARCH,
                "payload_digest": payload_digest,
                "files": [{ "path": "conductor", "digest": file_digest, "executable": true }]
            }))
            .unwrap(),
        )
        .unwrap();
        candidate
    }

    fn temporary(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "symphony-bundle-{name}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ))
    }
}
