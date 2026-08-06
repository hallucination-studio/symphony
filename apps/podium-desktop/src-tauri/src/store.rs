use crate::domain::{AgentKind, ProjectBinding};
use std::collections::HashSet;
use std::io;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PersistedState {
    pub bindings: Vec<ProjectBinding>,
}

pub struct JsonStore {
    path: PathBuf,
}

impl JsonStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn load(&self) -> io::Result<PersistedState> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(PersistedState::default());
            }
            Err(error) => return Err(error),
        };
        let state = serde_json::from_slice::<PersistedState>(&bytes).map_err(|error| {
            io::Error::new(io::ErrorKind::InvalidData, format!("invalid podium state: {error}"))
        })?;
        validate_state(&state)?;
        Ok(state)
    }

    /// Replace the state document.  Unix uses rename plus a parent-directory
    /// sync for durable replacement.  Windows is deliberately limited to the
    /// create-if-absent case because the standard library has no atomic
    /// overwrite primitive; an existing document returns `Unsupported`.
    pub fn replace(&self, state: &PersistedState) -> io::Result<()> {
        validate_state(state)?;
        let bytes = serde_json::to_vec_pretty(state).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("cannot encode podium state: {error}"),
            )
        })?;

        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        let file_name = self.path.file_name().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "state path has no file name")
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
            let mut temporary =
                std::fs::OpenOptions::new().create_new(true).write(true).open(&temporary_path)?;
            use std::io::Write;
            temporary.write_all(&bytes)?;
            temporary.sync_all()?;
            drop(temporary);
            replace_document(&temporary_path, &self.path, parent)
        })();

        if result.is_err() {
            let _ = std::fs::remove_file(&temporary_path);
        }
        result
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn validate_state(state: &PersistedState) -> io::Result<()> {
    let mut project_ids = HashSet::new();
    for binding in &state.bindings {
        if !valid_identifier(&binding.project_id)
            || !valid_identifier(&binding.routing_label)
            || binding.concurrency == 0
            || binding.reconcile_agent != AgentKind::Codex
            || binding.artist_agent != AgentKind::Codex
            || binding.critic_agent != AgentKind::Codex
        {
            return Err(invalid_state("invalid project binding"));
        }
        normalize_absolute_path(&binding.repository_path)
            .map_err(|_| invalid_state("invalid repository path"))?;
        if !project_ids.insert(&binding.project_id) {
            return Err(invalid_state("duplicate project id"));
        }
    }

    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.trim().is_empty() && !value.contains('\0') && !value.contains(['\r', '\n'])
}

fn normalize_absolute_path(value: &str) -> io::Result<PathBuf> {
    if value.trim().is_empty() || value.contains('\0') {
        return Err(invalid_state("empty path"));
    }
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(invalid_state("path must be absolute"));
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(invalid_state("path escapes its root"));
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    if normalized.is_absolute() {
        Ok(normalized)
    } else {
        Err(invalid_state("path must be absolute"))
    }
}

fn invalid_state(reason: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("invalid podium state: {reason}"))
}

pub(crate) fn replace_document(
    temporary: &Path,
    destination: &Path,
    parent: &Path,
) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::rename(temporary, destination)?;
        std::fs::File::open(parent)?.sync_all()
    }
    #[cfg(windows)]
    {
        let _ = parent;
        match std::fs::symlink_metadata(destination) {
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "atomic replacement of an existing state document is unsupported on Windows",
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        std::fs::rename(temporary, destination)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (temporary, destination, parent);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "atomic state replacement is unsupported on this platform",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_contains_only_bindings() {
        let dir = std::env::temp_dir().join(format!(
            "symphony-store-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let store = JsonStore::new(&path);
        let state = PersistedState {
            bindings: vec![ProjectBinding {
                project_id: "project-1".into(),
                routing_label: "core".into(),
                repository_path: "/repo".into(),
                base_branch: "main".into(),
                concurrency: 1,
                completed_workspace_retention: Some(3),
                reconcile_agent: AgentKind::Codex,
                reconcile_model: None,
                reconcile_reasoning_effort: None,
                artist_agent: AgentKind::Codex,
                artist_model: None,
                artist_reasoning_effort: None,
                critic_agent: AgentKind::Codex,
                critic_model: None,
                critic_reasoning_effort: None,
            }],
        };

        store.replace(&state).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("bindings"));
        assert!(!raw.contains("allocations"));
        assert!(!raw.contains("assignment"));
        assert!(!raw.contains("pid"));
        assert!(!raw.contains("queue"));
        assert!(!raw.contains("secret"));
        assert!(!raw.contains("api_key"));
        assert!(!raw.contains("access_token"));
        assert!(!raw.contains("process_handle"));
        assert_eq!(store.load().unwrap(), state);
    }

    #[test]
    #[cfg(unix)]
    fn replacing_state_atomically_exposes_the_complete_new_document() {
        let dir = std::env::temp_dir().join(format!(
            "symphony-store-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let store = JsonStore::new(&path);
        let first = PersistedState::default();
        store.replace(&first).unwrap();
        let second = PersistedState { bindings: vec![] };

        store.replace(&second).unwrap();

        assert_eq!(store.load().unwrap(), second);
        assert!(!std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".tmp")));
    }

    #[cfg(windows)]
    #[test]
    fn replacing_an_existing_document_is_explicitly_unsupported_on_windows() {
        let dir = std::env::temp_dir().join(format!(
            "symphony-store-windows-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let store = JsonStore::new(&path);
        store.replace(&PersistedState::default()).unwrap();

        let error = store.replace(&PersistedState::default()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Unsupported);
    }

    fn valid_binding(project_id: &str, concurrency: u32) -> ProjectBinding {
        ProjectBinding {
            project_id: project_id.into(),
            routing_label: "core".into(),
            repository_path: "/repo".into(),
            base_branch: "main".into(),
            concurrency,
            completed_workspace_retention: None,
            reconcile_agent: AgentKind::Codex,
            reconcile_model: None,
            reconcile_reasoning_effort: None,
            artist_agent: AgentKind::Codex,
            artist_model: None,
            artist_reasoning_effort: None,
            critic_agent: AgentKind::Codex,
            critic_model: None,
            critic_reasoning_effort: None,
        }
    }

    fn temporary_store_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "symphony-store-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ))
    }

    #[test]
    fn rejects_duplicate_ids_invalid_binding_fields_and_conflicting_paths() {
        let states = [
            PersistedState { bindings: vec![valid_binding("same", 1), valid_binding("same", 2)] },
            PersistedState { bindings: vec![valid_binding("project", 0)] },
            PersistedState {
                bindings: vec![ProjectBinding {
                    routing_label: "\n".into(),
                    ..valid_binding("project", 1)
                }],
            },
        ];

        for (index, state) in states.iter().enumerate() {
            let path = temporary_store_path(&format!("invalid-{index}"));
            let store = JsonStore::new(&path);
            assert!(store.replace(state).is_err(), "invalid state {index} was written");
            std::fs::write(&path, serde_json::to_vec(state).unwrap()).unwrap();
            assert!(store.load().is_err(), "invalid state {index} was loaded");
        }
    }

    #[test]
    fn rejects_legacy_allocations_field() {
        let path = temporary_store_path("priority");
        std::fs::write(&path, r#"{"bindings":[],"allocations":[]}"#).unwrap();

        let error = JsonStore::new(path).load().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn unknown_runtime_or_secret_fields_are_rejected() {
        let dir = std::env::temp_dir().join(format!(
            "symphony-store-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        std::fs::write(
            &path,
            r#"{"bindings":[],"allocations":[],"assignment":{},"pid":7,"queue":[],"api_key":"secret"}"#,
        )
        .unwrap();

        let error = JsonStore::new(path).load().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
