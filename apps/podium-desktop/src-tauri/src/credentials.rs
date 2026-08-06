//! Desktop-owned Linear OAuth credential storage.
//!
//! The credentials file is the only place OAuth tokens rest (TM-CRED-003):
//! one JSON document with owner-only permissions, next to but separate from
//! the binding state document.  Writes reuse the store's atomic replacement;
//! like the state store, overwriting an existing document is unsupported on
//! Windows.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

const CREDENTIALS_FILE: &str = "credentials.json";
const MAX_CREDENTIAL_FIELD: usize = 16_384;

/// One Linear OAuth session for the built-in application.  Tokens never
/// appear in `Debug`, logs, or any other document.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredCredentials {
    pub client_id: String,
    pub organization: String,
    pub access_token: String,
    pub refresh_token: String,
    /// Unix seconds after which the access token must be refreshed.
    pub expires_at_unix: u64,
}

impl fmt::Debug for StoredCredentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StoredCredentials")
            .field("client_id", &self.client_id)
            .field("organization", &self.organization)
            .field("access_token", &"<redacted>")
            .field("refresh_token", &"<redacted>")
            .field("expires_at_unix", &self.expires_at_unix)
            .finish()
    }
}

impl StoredCredentials {
    pub fn new(
        client_id: impl Into<String>,
        organization: impl Into<String>,
        access_token: impl Into<String>,
        refresh_token: impl Into<String>,
        expires_at_unix: u64,
    ) -> io::Result<Self> {
        let credentials = Self {
            client_id: client_id.into(),
            organization: organization.into(),
            access_token: access_token.into(),
            refresh_token: refresh_token.into(),
            expires_at_unix,
        };
        validate(&credentials)?;
        Ok(credentials)
    }

    pub fn access_token_expires_within(&self, seconds: u64, now_unix: u64) -> bool {
        self.expires_at_unix <= now_unix.saturating_add(seconds)
    }
}

fn validate(credentials: &StoredCredentials) -> io::Result<()> {
    for value in [
        &credentials.client_id,
        &credentials.organization,
        &credentials.access_token,
        &credentials.refresh_token,
    ] {
        if value.trim().is_empty()
            || value.len() > MAX_CREDENTIAL_FIELD
            || value.chars().any(|ch| ch == '\0' || ch == '\r' || ch == '\n')
        {
            return Err(invalid_credentials());
        }
    }
    if credentials.expires_at_unix == 0 {
        return Err(invalid_credentials());
    }
    Ok(())
}

fn invalid_credentials() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid podium credentials")
}

pub struct CredentialStore {
    path: PathBuf,
}

impl CredentialStore {
    pub fn new(data_root: &Path) -> Self {
        Self { path: data_root.join(CREDENTIALS_FILE) }
    }

    /// The stored session, or `None` when Desktop has never connected.
    /// A malformed document is a load error, never a silent disconnect.
    pub fn load(&self) -> io::Result<Option<StoredCredentials>> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let credentials = serde_json::from_slice::<StoredCredentials>(&bytes)
            .map_err(|_| invalid_credentials())?;
        validate(&credentials)?;
        Ok(Some(credentials))
    }

    pub fn replace(&self, credentials: &StoredCredentials) -> io::Result<()> {
        validate(credentials)?;
        let bytes = serde_json::to_vec_pretty(credentials).map_err(|_| invalid_credentials())?;

        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        let file_name = self.path.file_name().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "credentials path has no file name")
        })?;
        let unique = format!(
            ".{}.{}.{}.tmp",
            file_name.to_string_lossy(),
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        );
        let temporary_path = parent.join(unique);

        let result = (|| {
            let mut options = std::fs::OpenOptions::new();
            options.create_new(true).write(true);
            // Owner-only from creation; the file never exists with wider
            // permissions.  Windows has no Unix mode bits and is limited to
            // the create-if-absent case by `replace_document`.
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut temporary = options.open(&temporary_path)?;
            use std::io::Write;
            temporary.write_all(&bytes)?;
            temporary.sync_all()?;
            drop(temporary);
            crate::store::replace_document(&temporary_path, &self.path, parent)
        })();

        if result.is_err() {
            let _ = std::fs::remove_file(&temporary_path);
        }
        result
    }

    /// Forget the session (TM-CRED-007): a later connect starts a fresh
    /// authorization; nothing is repaired or recovered.
    pub fn clear(&self) -> io::Result<()> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> StoredCredentials {
        StoredCredentials::new(
            "client-1",
            "Acme",
            "access-fixture-secret",
            "refresh-fixture-secret",
            4_000_000_000,
        )
        .unwrap()
    }

    fn temporary_root(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "symphony-credentials-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trip_keeps_tokens_out_of_debug() {
        let store = CredentialStore::new(&temporary_root("round-trip"));
        assert_eq!(store.load().unwrap(), None);
        store.replace(&fixture()).unwrap();
        assert_eq!(store.load().unwrap(), Some(fixture()));
        let debug = format!("{:?}", fixture());
        assert!(debug.contains("Acme"));
        assert!(!debug.contains("fixture-secret"));
    }

    #[test]
    #[cfg(unix)]
    fn credentials_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let root = temporary_root("mode");
        let store = CredentialStore::new(&root);
        store.replace(&fixture()).unwrap();
        let mode = std::fs::metadata(root.join(CREDENTIALS_FILE)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn clear_forgets_the_session_and_tolerates_absence() {
        let store = CredentialStore::new(&temporary_root("clear"));
        store.clear().unwrap();
        store.replace(&fixture()).unwrap();
        store.clear().unwrap();
        assert_eq!(store.load().unwrap(), None);
    }

    #[test]
    fn rejects_malformed_or_secret_shaped_garbage() {
        let root = temporary_root("invalid");
        let store = CredentialStore::new(&root);
        std::fs::write(root.join(CREDENTIALS_FILE), r#"{"client_id":"x"}"#).unwrap();
        assert_eq!(store.load().unwrap_err().kind(), io::ErrorKind::InvalidData);
        let mut broken = fixture();
        broken.access_token = "has\nnewline".into();
        assert!(store.replace(&broken).is_err());
    }
}
