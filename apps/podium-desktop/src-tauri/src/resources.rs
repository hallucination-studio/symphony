//! Deterministic local paths for one Podium Root.
//!
//! Podium derives a preferred workspace and external run directory from its
//! app-data root and the provider Root ID. Root Reconcile owns any worktree
//! creation at the preferred workspace; this module creates only the run
//! directory used for private Conductor diagnostics and cycle records.

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const WORKSPACE_DIRECTORY: &str = "workspaces";
const RUN_DIRECTORY: &str = "runs";
const MAX_ROOT_ID_LENGTH: usize = 256;
const MAX_GIT_OUTPUT_BYTES: usize = 4 * 1024;

/// A bounded, sanitized resource error. Filesystem and Git details never cross
/// this boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceError {
    InvalidInput,
    AppDataRootInvalid,
    RepositoryInvalid,
    WorkspaceInvalid,
    WorkspaceDirty,
    Git,
    Io,
}

impl fmt::Display for ResourceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "root_resource_input_invalid",
            Self::AppDataRootInvalid => "root_resource_app_data_root_invalid",
            Self::RepositoryInvalid => "root_resource_repository_invalid",
            Self::WorkspaceInvalid => "root_resource_workspace_invalid",
            Self::WorkspaceDirty => "root_resource_workspace_dirty",
            Self::Git => "root_resource_git_failed",
            Self::Io => "root_resource_io_failed",
        })
    }
}

impl std::error::Error for ResourceError {}

/// Deterministic paths supplied to one Conductor launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootResources {
    pub workspace_path: PathBuf,
    pub run_directory: PathBuf,
}

/// Derives paths under one caller-selected app-data root.
#[derive(Clone, PartialEq, Eq)]
pub struct RootResourceAllocator {
    app_data_root: PathBuf,
}

pub type RootAllocator = RootResourceAllocator;

impl fmt::Debug for RootResourceAllocator {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RootResourceAllocator")
            .field("app_data_root", &self.app_data_root)
            .finish()
    }
}

impl RootResourceAllocator {
    pub fn new(app_data_root: impl Into<PathBuf>) -> Self {
        Self { app_data_root: app_data_root.into() }
    }

    pub fn app_data_root(&self) -> &Path {
        &self.app_data_root
    }

    /// Derive stable paths and ensure the external run directory exists.
    ///
    /// This operation is idempotent so a Desktop restart derives the same
    /// paths without reading a durable allocation record. The workspace is
    /// deliberately left absent when Root Reconcile has not prepared it.
    pub fn allocate(&self, root_id: &str) -> Result<RootResources, ResourceError> {
        validate_root_id(root_id)?;
        let app_data_root = prepare_app_data_root(&self.app_data_root)?;
        let slug = stable_slug(root_id);
        let workspace_path = app_data_root.join(WORKSPACE_DIRECTORY).join(&slug);
        let run_directory = app_data_root.join(RUN_DIRECTORY).join(&slug);

        fs::create_dir_all(workspace_path.parent().ok_or(ResourceError::AppDataRootInvalid)?)
            .map_err(|_| ResourceError::Io)?;
        fs::create_dir_all(run_directory.parent().ok_or(ResourceError::AppDataRootInvalid)?)
            .map_err(|_| ResourceError::Io)?;
        fs::create_dir_all(&run_directory).map_err(|_| ResourceError::Io)?;

        Ok(RootResources { workspace_path, run_directory })
    }

    pub fn allocate_root(&self, root_id: &str) -> Result<RootResources, ResourceError> {
        self.allocate(root_id)
    }

    /// Remove one completed Root worktree after an explicit operator action.
    ///
    /// The target is derived from this allocator's app-data root and `root_id`;
    /// callers cannot supply an arbitrary path. Git must identify the target
    /// as a clean linked worktree of `repository_path` before the bounded,
    /// non-forced removal is attempted. The diagnostics directory is never
    /// touched by this operation.
    pub fn cleanup_workspace(
        &self,
        repository_path: impl AsRef<Path>,
        root_id: &str,
    ) -> Result<(), ResourceError> {
        validate_root_id(root_id)?;
        let app_data_root = existing_app_data_root(&self.app_data_root)?;
        let repository = canonical_repository(repository_path.as_ref())?;
        validate_disjoint_paths(&app_data_root, &repository)?;
        let workspace = derived_workspace_target(&app_data_root, root_id)?;
        validate_workspace(&workspace, &app_data_root, &repository)?;
        if workspace_is_dirty(&workspace)? {
            return Err(ResourceError::WorkspaceDirty);
        }
        remove_worktree(&repository, &workspace)
    }
}

/// Derive the stable path component used for both workspace and run paths.
pub fn root_resource_slug(root_id: &str) -> Result<String, ResourceError> {
    validate_root_id(root_id)?;
    Ok(stable_slug(root_id))
}

fn prepare_app_data_root(path: &Path) -> Result<PathBuf, ResourceError> {
    if !path.is_absolute() {
        return Err(ResourceError::AppDataRootInvalid);
    }
    fs::create_dir_all(path).map_err(|_| ResourceError::AppDataRootInvalid)?;
    let canonical = fs::canonicalize(path).map_err(|_| ResourceError::AppDataRootInvalid)?;
    if !canonical.is_dir() {
        return Err(ResourceError::AppDataRootInvalid);
    }
    Ok(canonical)
}

fn existing_app_data_root(path: &Path) -> Result<PathBuf, ResourceError> {
    if !path.is_absolute() || path.to_string_lossy().contains('\0') {
        return Err(ResourceError::AppDataRootInvalid);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| ResourceError::AppDataRootInvalid)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ResourceError::AppDataRootInvalid);
    }
    let canonical = fs::canonicalize(path).map_err(|_| ResourceError::AppDataRootInvalid)?;
    if !canonical.is_dir() {
        return Err(ResourceError::AppDataRootInvalid);
    }
    Ok(canonical)
}

fn canonical_repository(path: &Path) -> Result<PathBuf, ResourceError> {
    if !path.is_absolute() || path.to_string_lossy().contains('\0') {
        return Err(ResourceError::RepositoryInvalid);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| ResourceError::RepositoryInvalid)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ResourceError::RepositoryInvalid);
    }
    let canonical = fs::canonicalize(path).map_err(|_| ResourceError::RepositoryInvalid)?;
    let top = git_output(&canonical, &["rev-parse", "--show-toplevel"])
        .map_err(|_| ResourceError::RepositoryInvalid)?;
    let top = canonicalize_git_path(&canonical, top.trim())
        .map_err(|_| ResourceError::RepositoryInvalid)?;
    if top != canonical {
        return Err(ResourceError::RepositoryInvalid);
    }
    let bare = git_output(&canonical, &["rev-parse", "--is-bare-repository"])
        .map_err(|_| ResourceError::RepositoryInvalid)?;
    if bare.trim() != "false" {
        return Err(ResourceError::RepositoryInvalid);
    }
    Ok(canonical)
}

fn derived_workspace_target(app_data_root: &Path, root_id: &str) -> Result<PathBuf, ResourceError> {
    let workspace_directory = app_data_root.join(WORKSPACE_DIRECTORY);
    let metadata =
        fs::symlink_metadata(&workspace_directory).map_err(|_| ResourceError::WorkspaceInvalid)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ResourceError::WorkspaceInvalid);
    }
    let canonical_directory =
        fs::canonicalize(&workspace_directory).map_err(|_| ResourceError::WorkspaceInvalid)?;
    if canonical_directory != workspace_directory || !canonical_directory.starts_with(app_data_root)
    {
        return Err(ResourceError::WorkspaceInvalid);
    }

    let target = workspace_directory.join(stable_slug(root_id));
    let metadata = fs::symlink_metadata(&target).map_err(|_| ResourceError::WorkspaceInvalid)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ResourceError::WorkspaceInvalid);
    }
    let canonical_target =
        fs::canonicalize(&target).map_err(|_| ResourceError::WorkspaceInvalid)?;
    if canonical_target != target || !canonical_target.starts_with(app_data_root) {
        return Err(ResourceError::WorkspaceInvalid);
    }
    Ok(target)
}

fn validate_workspace(
    workspace: &Path,
    app_data_root: &Path,
    repository: &Path,
) -> Result<(), ResourceError> {
    if workspace == app_data_root
        || workspace == repository
        || workspace.starts_with(repository)
        || repository.starts_with(workspace)
    {
        return Err(ResourceError::WorkspaceInvalid);
    }
    let top = git_output(workspace, &["rev-parse", "--show-toplevel"])
        .map_err(|_| ResourceError::WorkspaceInvalid)?;
    let top = canonicalize_git_path(workspace, top.trim())
        .map_err(|_| ResourceError::WorkspaceInvalid)?;
    if top != workspace {
        return Err(ResourceError::WorkspaceInvalid);
    }
    let inside = git_output(workspace, &["rev-parse", "--is-inside-work-tree"])
        .map_err(|_| ResourceError::WorkspaceInvalid)?;
    if inside.trim() != "true" {
        return Err(ResourceError::WorkspaceInvalid);
    }
    let repository_common = git_output(repository, &["rev-parse", "--git-common-dir"])
        .map_err(|_| ResourceError::RepositoryInvalid)?;
    let repository_common = canonicalize_git_path(repository, repository_common.trim())
        .map_err(|_| ResourceError::RepositoryInvalid)?;
    let workspace_common = git_output(workspace, &["rev-parse", "--git-common-dir"])
        .map_err(|_| ResourceError::WorkspaceInvalid)?;
    let workspace_common = canonicalize_git_path(workspace, workspace_common.trim())
        .map_err(|_| ResourceError::WorkspaceInvalid)?;
    if workspace_common != repository_common {
        return Err(ResourceError::WorkspaceInvalid);
    }
    if !workspace.starts_with(app_data_root) {
        return Err(ResourceError::WorkspaceInvalid);
    }
    Ok(())
}

fn workspace_is_dirty(workspace: &Path) -> Result<bool, ResourceError> {
    let status = git_output(
        workspace,
        &["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
    )
    .map_err(|_| ResourceError::WorkspaceInvalid)?;
    Ok(!status.is_empty())
}

fn remove_worktree(repository: &Path, workspace: &Path) -> Result<(), ResourceError> {
    let status = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(["worktree", "remove", "--"])
        .arg(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| ResourceError::Git)?;
    if status.success() {
        Ok(())
    } else {
        Err(ResourceError::Git)
    }
}

fn validate_disjoint_paths(app_data_root: &Path, repository: &Path) -> Result<(), ResourceError> {
    if app_data_root == repository
        || app_data_root.starts_with(repository)
        || repository.starts_with(app_data_root)
    {
        return Err(ResourceError::AppDataRootInvalid);
    }
    Ok(())
}

fn canonicalize_git_path(cwd: &Path, value: &str) -> Result<PathBuf, ResourceError> {
    if value.is_empty() || value.contains('\0') {
        return Err(ResourceError::Git);
    }
    let path = Path::new(value);
    let path = if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) };
    fs::canonicalize(path).map_err(|_| ResourceError::Git)
}

fn git_output(repository: &Path, args: &[&str]) -> Result<String, ResourceError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| ResourceError::Git)?;
    if !output.status.success() || output.stdout.len() > MAX_GIT_OUTPUT_BYTES {
        return Err(ResourceError::Git);
    }
    String::from_utf8(output.stdout).map_err(|_| ResourceError::Git)
}

fn validate_root_id(root_id: &str) -> Result<(), ResourceError> {
    if root_id.is_empty()
        || root_id.len() > MAX_ROOT_ID_LENGTH
        || root_id.chars().any(|ch| ch == '\0' || ch == '\r' || ch == '\n')
    {
        return Err(ResourceError::InvalidInput);
    }
    Ok(())
}

fn stable_slug(root_id: &str) -> String {
    let mut readable = String::new();
    for character in root_id.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
            readable.push(character.to_ascii_lowercase());
        } else if !readable.ends_with('-') {
            readable.push('-');
        }
    }
    let readable = readable.trim_matches(['-', '.']).to_owned();
    let readable = if readable.is_empty() { "root".to_owned() } else { readable };
    let digest = fnv1a_hex(root_id.as_bytes());
    let readable = readable.chars().take(48).collect::<String>();
    format!("{readable}-{digest}")
}

fn fnv1a_hex(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "symphony-resource-{label}-{}-{}",
                std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn git(repository: &Path, args: &[&str]) {
        let output = Command::new("git").arg("-C").arg(repository).args(args).output().unwrap();
        assert!(output.status.success(), "git fixture command failed: {args:?}");
    }

    fn fixture_repo(temp: &TempDir, name: &str) -> PathBuf {
        let repository = temp.path().join(name);
        fs::create_dir_all(&repository).unwrap();
        git(&repository, &["init", "-q", "-b", "main"]);
        git(&repository, &["config", "user.email", "fixture@example.invalid"]);
        git(&repository, &["config", "user.name", "Fixture"]);
        fs::write(repository.join("README.md"), "fixture\n").unwrap();
        git(&repository, &["add", "README.md"]);
        git(&repository, &["commit", "-qm", "initial"]);
        repository
    }

    fn add_worktree(repository: &Path, target: &Path, root_id: &str) {
        let branch = format!("fixture/{}", root_resource_slug(root_id).unwrap());
        let output = Command::new("git")
            .arg("-C")
            .arg(repository)
            .args(["worktree", "add", "-b"])
            .arg(branch)
            .arg(target)
            .arg("HEAD")
            .output()
            .unwrap();
        assert!(output.status.success(), "git worktree fixture failed");
    }

    #[test]
    fn derives_preferred_workspace_and_creates_only_the_run_directory() {
        let temp = TempDir::new("first");
        let allocator = RootResourceAllocator::new(temp.path().join("app"));

        let resources = allocator.allocate("issue-123").unwrap();

        assert!(!resources.workspace_path.exists());
        assert!(resources.run_directory.is_dir());
        let app_data = fs::canonicalize(temp.path().join("app")).unwrap();
        assert!(resources.workspace_path.starts_with(&app_data));
        assert!(resources.run_directory.starts_with(&app_data));
    }

    #[test]
    fn restart_derives_the_same_paths_and_accepts_a_root_worktree() {
        let temp = TempDir::new("restart");
        let app_data = temp.path().join("app");
        let allocator = RootResourceAllocator::new(&app_data);
        let first = allocator.allocate("issue-123").unwrap();
        fs::create_dir_all(&first.workspace_path).unwrap();

        let second = RootResourceAllocator::new(&app_data).allocate("issue-123").unwrap();

        assert_eq!(second, first);
        assert!(second.workspace_path.is_dir());
        assert!(second.run_directory.is_dir());
    }

    #[test]
    fn derives_distinct_stable_paths_without_git_or_persisted_allocations() {
        let temp = TempDir::new("stable");
        let allocator = RootResourceAllocator::new(temp.path().join("app"));
        let first = allocator.allocate("TEAM/123 unsafe").unwrap();
        let second = allocator.allocate("TEAM/123 unsafe").unwrap();
        let other = allocator.allocate("TEAM/124 unsafe").unwrap();

        assert_eq!(first, second);
        assert_ne!(first, other);
        assert!(root_resource_slug("TEAM/123 unsafe")
            .unwrap()
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.')));
        assert_eq!(root_resource_slug("bad\nroot"), Err(ResourceError::InvalidInput));
    }

    #[test]
    fn rejects_relative_app_data_and_invalid_root_ids() {
        assert_eq!(
            RootResourceAllocator::new("relative").allocate("issue-123"),
            Err(ResourceError::AppDataRootInvalid),
        );
        let temp = TempDir::new("invalid");
        let allocator = RootResourceAllocator::new(temp.path().join("app"));
        assert_eq!(allocator.allocate(""), Err(ResourceError::InvalidInput));
        assert_eq!(allocator.allocate("bad\nroot"), Err(ResourceError::InvalidInput));
    }

    #[test]
    fn cleanup_removes_only_a_clean_worktree_and_keeps_run_diagnostics() {
        let temp = TempDir::new("cleanup-success");
        let repository = fixture_repo(&temp, "repo");
        let allocator = RootResourceAllocator::new(temp.path().join("app"));
        let root_id = "issue-123";
        let resources = allocator.allocate(root_id).unwrap();
        add_worktree(&repository, &resources.workspace_path, root_id);
        let diagnostic = resources.run_directory.join("diagnostic.json");
        fs::write(&diagnostic, "{\"event\":\"done\"}\n").unwrap();

        allocator.cleanup_workspace(&repository, root_id).unwrap();

        assert!(!resources.workspace_path.exists());
        assert!(resources.run_directory.is_dir());
        assert_eq!(fs::read_to_string(diagnostic).unwrap(), "{\"event\":\"done\"}\n");
    }

    #[test]
    fn cleanup_rejects_dirty_worktree_and_preserves_workspace_and_diagnostics() {
        let temp = TempDir::new("cleanup-dirty");
        let repository = fixture_repo(&temp, "repo");
        let allocator = RootResourceAllocator::new(temp.path().join("app"));
        let root_id = "issue-123";
        let resources = allocator.allocate(root_id).unwrap();
        add_worktree(&repository, &resources.workspace_path, root_id);
        let diagnostic = resources.run_directory.join("diagnostic.json");
        fs::write(&diagnostic, "private evidence\n").unwrap();
        fs::write(resources.workspace_path.join("dirty.txt"), "keep me\n").unwrap();

        assert_eq!(
            allocator.cleanup_workspace(&repository, root_id),
            Err(ResourceError::WorkspaceDirty)
        );

        assert!(resources.workspace_path.is_dir());
        assert!(resources.workspace_path.join("dirty.txt").is_file());
        assert_eq!(fs::read_to_string(diagnostic).unwrap(), "private evidence\n");
    }

    #[test]
    fn cleanup_rejects_wrong_repository_or_root_without_boundary_escape() {
        let temp = TempDir::new("cleanup-boundary");
        let repository = fixture_repo(&temp, "repo");
        let wrong_repository = fixture_repo(&temp, "wrong-repo");
        let allocator = RootResourceAllocator::new(temp.path().join("app"));
        let root_id = "issue-123";
        let resources = allocator.allocate(root_id).unwrap();
        add_worktree(&repository, &resources.workspace_path, root_id);

        assert!(allocator.cleanup_workspace(&wrong_repository, root_id).is_err());
        assert!(resources.workspace_path.is_dir());
        assert!(allocator.cleanup_workspace(&repository, "other-root").is_err());
        assert!(resources.workspace_path.is_dir());

        allocator.cleanup_workspace(&repository, root_id).unwrap();
        assert!(!resources.workspace_path.exists());
    }

    #[test]
    fn cleanup_rejects_a_non_worktree_directory_without_removing_it() {
        let temp = TempDir::new("cleanup-non-worktree");
        let repository = fixture_repo(&temp, "repo");
        let allocator = RootResourceAllocator::new(temp.path().join("app"));
        let root_id = "issue-123";
        let resources = allocator.allocate(root_id).unwrap();
        fs::create_dir_all(&resources.workspace_path).unwrap();

        assert_eq!(
            allocator.cleanup_workspace(&repository, root_id),
            Err(ResourceError::WorkspaceInvalid)
        );
        assert!(resources.workspace_path.is_dir());
    }
}
