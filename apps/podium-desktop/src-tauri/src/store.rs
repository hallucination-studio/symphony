use crate::domain::{ProjectBinding, RootAllocation};
use std::collections::HashSet;
use std::io;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PersistedState {
    pub bindings: Vec<ProjectBinding>,
    pub allocations: Vec<RootAllocation>,
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
            || binding.reconcile_agent != "codex"
            || binding.execute_agent != "codex"
            || binding.audit_agent != "codex"
        {
            return Err(invalid_state("invalid project binding"));
        }
        normalize_absolute_path(&binding.repository_path)
            .map_err(|_| invalid_state("invalid repository path"))?;
        if !project_ids.insert(&binding.project_id) {
            return Err(invalid_state("duplicate project id"));
        }
    }

    let mut root_ids = HashSet::new();
    let mut paths: Vec<PathBuf> = Vec::with_capacity(state.allocations.len() * 2);
    for allocation in &state.allocations {
        if !valid_identifier(&allocation.root_id) {
            return Err(invalid_state("invalid root id"));
        }
        if !root_ids.insert(&allocation.root_id) {
            return Err(invalid_state("duplicate root id"));
        }

        for value in [&allocation.workspace_path, &allocation.run_directory] {
            let path = normalize_absolute_path(value)
                .map_err(|_| invalid_state("invalid allocation path"))?;
            if paths.iter().any(|existing| paths_conflict(existing, &path)) {
                return Err(invalid_state("conflicting allocation paths"));
            }
            paths.push(path);
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

fn comparable_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(path.to_string_lossy().to_ascii_lowercase())
    }
    #[cfg(not(windows))]
    {
        path.to_owned()
    }
}

fn paths_conflict(left: &Path, right: &Path) -> bool {
    let left = comparable_path(left);
    let right = comparable_path(right);
    left == right || left.starts_with(&right) || right.starts_with(&left)
}

fn invalid_state(reason: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("invalid podium state: {reason}"))
}

fn replace_document(temporary: &Path, destination: &Path, parent: &Path) -> io::Result<()> {
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
    fn round_trip_contains_only_bindings_and_allocations() {
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
                reconcile_agent: "codex".into(),
                reconcile_model: None,
                reconcile_reasoning_effort: None,
                execute_agent: "codex".into(),
                execute_model: None,
                execute_reasoning_effort: None,
                audit_agent: "codex".into(),
                audit_model: None,
                audit_reasoning_effort: None,
            }],
            allocations: Vec::new(),
        };

        store.replace(&state).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("bindings"));
        assert!(raw.contains("allocations"));
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
        let second = PersistedState {
            bindings: vec![],
            allocations: vec![RootAllocation {
                root_id: "ENG-2".into(),
                workspace_path: "/work/ENG-2".into(),
                run_directory: "/runs/ENG-2".into(),
            }],
        };

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
            reconcile_agent: "codex".into(),
            reconcile_model: None,
            reconcile_reasoning_effort: None,
            execute_agent: "codex".into(),
            execute_model: None,
            execute_reasoning_effort: None,
            audit_agent: "codex".into(),
            audit_model: None,
            audit_reasoning_effort: None,
        }
    }

    fn valid_allocation(
        root_id: &str,
        workspace_path: &str,
        run_directory: &str,
    ) -> RootAllocation {
        RootAllocation {
            root_id: root_id.into(),
            workspace_path: workspace_path.into(),
            run_directory: run_directory.into(),
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
            PersistedState {
                bindings: vec![valid_binding("same", 1), valid_binding("same", 2)],
                allocations: Vec::new(),
            },
            PersistedState { bindings: vec![valid_binding("project", 0)], allocations: Vec::new() },
            PersistedState {
                bindings: vec![ProjectBinding {
                    execute_agent: "other".into(),
                    ..valid_binding("project", 1)
                }],
                allocations: Vec::new(),
            },
            PersistedState {
                bindings: vec![valid_binding("project", 1)],
                allocations: vec![
                    valid_allocation("root-a", "/state/workspace", "/state/run-a"),
                    valid_allocation("root-a", "/state/other", "/state/run-b"),
                ],
            },
            PersistedState {
                bindings: vec![valid_binding("project", 1)],
                allocations: vec![
                    valid_allocation("root-a", "/state/workspace", "/state/run-a"),
                    valid_allocation("root-b", "/state/workspace/child", "/state/run-b"),
                ],
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
    fn rejects_priority_fields_in_persisted_allocations() {
        let path = temporary_store_path("priority");
        std::fs::write(
            &path,
            r#"{"bindings":[],"allocations":[{"root_id":"root","workspace_path":"/state/workspace","run_directory":"/state/run","priority":1}]}"#,
        )
        .unwrap();

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
