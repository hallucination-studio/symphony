//! Stable local resources for one Podium Root allocation.
//!
//! The allocator owns creation and validation of a Root worktree and its
//! external run directory.  It never removes, resets, adopts, or replaces an
//! existing resource.  Assignment and process state remain outside this
//! module.

use crate::domain::{ProjectBinding, RootAllocation};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const WORKSPACE_DIRECTORY: &str = "workspaces";
const RUN_DIRECTORY: &str = "runs";
const MAX_ROOT_ID_LENGTH: usize = 256;
const MAX_BRANCH_LENGTH: usize = 200;

/// A bounded, sanitized resource-allocation error.  Git output is deliberately
/// discarded: it can contain arbitrary repository hooks or user data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceError {
    InvalidInput,
    RepositoryInvalid,
    BaseBranchInvalid,
    AppDataRootInvalid,
    AllocationMismatch,
    ResourceExists,
    ResourceMissing,
    ResourceInvalid,
    Io,
    Git,
}

impl fmt::Display for ResourceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "root_resource_input_invalid",
            Self::RepositoryInvalid => "root_resource_repository_invalid",
            Self::BaseBranchInvalid => "root_resource_base_branch_invalid",
            Self::AppDataRootInvalid => "root_resource_app_data_root_invalid",
            Self::AllocationMismatch => "root_resource_allocation_mismatch",
            Self::ResourceExists => "root_resource_already_exists",
            Self::ResourceMissing => "root_resource_missing",
            Self::ResourceInvalid => "root_resource_invalid",
            Self::Io => "root_resource_io_failed",
            Self::Git => "root_resource_git_failed",
        })
    }
}

impl std::error::Error for ResourceError {}

/// Allocates under one caller-selected app-data root.
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

    /// Allocate or validate one stable Root allocation.
    ///
    /// `existing` is the persisted allocation loaded after a Desktop restart.
    /// When present, its paths are used exactly as supplied and are validated
    /// against the repository and generated branch.  No replacement paths are
    /// derived in that branch.
    pub fn allocate(
        &self,
        binding: &ProjectBinding,
        root_id: &str,
        existing: Option<&RootAllocation>,
    ) -> Result<RootAllocation, ResourceError> {
        validate_root_id(root_id)?;
        validate_base_branch(&binding.base_branch)?;

        let repository = canonical_repository(Path::new(&binding.repository_path))?;
        let app_data_root = prepare_app_data_root(&self.app_data_root)?;
        let app_data_canonical =
            fs::canonicalize(&app_data_root).map_err(|_| ResourceError::AppDataRootInvalid)?;
        if repository == app_data_canonical
            || repository.starts_with(&app_data_canonical)
            || app_data_canonical.starts_with(&repository)
        {
            // The app-data root must not be the repository itself or live
            // inside it (and vice versa), otherwise a worktree could overlap
            // the source checkout and lose isolation.
            return Err(ResourceError::AppDataRootInvalid);
        }

        let slug = stable_slug(root_id);
        let branch = branch_name_from_slug(&slug)?;

        if let Some(existing) = existing {
            if existing.root_id != root_id {
                return Err(ResourceError::AllocationMismatch);
            }
            let workspace = absolute_path(Path::new(&existing.workspace_path))?;
            let run_directory = absolute_path(Path::new(&existing.run_directory))?;
            assert_within(&app_data_root, &workspace)?;
            assert_within(&app_data_root, &run_directory)?;
            let workspace_real =
                fs::canonicalize(&workspace).map_err(|_| ResourceError::ResourceMissing)?;
            let run_directory_real =
                fs::canonicalize(&run_directory).map_err(|_| ResourceError::ResourceMissing)?;
            assert_within(&app_data_canonical, &workspace_real)?;
            assert_within(&app_data_canonical, &run_directory_real)?;
            if workspace == run_directory || workspace == repository || run_directory == repository
            {
                return Err(ResourceError::AllocationMismatch);
            }
            if workspace_real.starts_with(&repository)
                || repository.starts_with(&workspace_real)
                || run_directory_real.starts_with(&workspace_real)
                || workspace_real.starts_with(&run_directory_real)
            {
                return Err(ResourceError::AllocationMismatch);
            }
            validate_existing_workspace(&workspace, &repository, &branch)?;
            validate_existing_run_directory(&run_directory)?;
            return Ok(existing.clone());
        }

        let workspace = app_data_root.join(WORKSPACE_DIRECTORY).join(&slug);
        let run_directory = app_data_root.join(RUN_DIRECTORY).join(&slug);
        assert_within(&app_data_root, &workspace)?;
        assert_within(&app_data_root, &run_directory)?;
        if workspace.starts_with(&repository) || repository.starts_with(&workspace) {
            return Err(ResourceError::AppDataRootInvalid);
        }
        if workspace.exists() || run_directory.exists() {
            // Never adopt an untracked directory.  The caller must provide the
            // exact persisted allocation if it intends to reuse one.
            return Err(ResourceError::ResourceExists);
        }

        fs::create_dir_all(workspace.parent().ok_or(ResourceError::AppDataRootInvalid)?)
            .map_err(|_| ResourceError::Io)?;
        fs::create_dir_all(run_directory.parent().ok_or(ResourceError::AppDataRootInvalid)?)
            .map_err(|_| ResourceError::Io)?;

        // Creation is intentionally delegated to Git.  In particular, this is
        // `worktree add -b`, not a copied checkout or a branch reset.
        let output = Command::new("git")
            .arg("-C")
            .arg(&repository)
            .arg("worktree")
            .arg("add")
            .arg("-b")
            .arg(&branch)
            .arg(&workspace)
            .arg(&binding.base_branch)
            .output()
            .map_err(|_| ResourceError::Git)?;
        if !output.status.success() {
            return Err(ResourceError::Git);
        }

        // Keep the run directory outside the worktree and create it only after
        // Git has confirmed the branch/worktree.  If this fails, leave the
        // worktree intact for operator inspection; no cleanup is attempted.
        if let Err(error) = fs::create_dir(&run_directory) {
            return Err(if error.kind() == std::io::ErrorKind::AlreadyExists {
                ResourceError::ResourceExists
            } else {
                ResourceError::Io
            });
        }

        let allocation = RootAllocation {
            root_id: root_id.to_owned(),
            workspace_path: path_string(&workspace)?,
            run_directory: path_string(&run_directory)?,
        };
        validate_existing_workspace(&workspace, &repository, &branch)?;
        validate_existing_run_directory(&run_directory)?;
        Ok(allocation)
    }

    pub fn allocate_root(
        &self,
        binding: &ProjectBinding,
        root_id: &str,
        existing: Option<&RootAllocation>,
    ) -> Result<RootAllocation, ResourceError> {
        self.allocate(binding, root_id, existing)
    }
}

/// Convenience function for callers that do not need to retain an allocator.
pub fn allocate_root_allocation(
    repository_path: impl AsRef<Path>,
    base_branch: &str,
    root_id: &str,
    app_data_root: impl AsRef<Path>,
    existing: Option<&RootAllocation>,
) -> Result<RootAllocation, ResourceError> {
    let binding = ProjectBinding {
        project_id: "resource-allocation".into(),
        routing_label: "resource-allocation".into(),
        repository_path: path_string(repository_path.as_ref())?,
        base_branch: base_branch.to_owned(),
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
    };
    // Keep this helper's public input focused on repository/base/root while
    // using the same validation and Git path as ProjectBinding callers.
    RootResourceAllocator::new(app_data_root.as_ref()).allocate(&binding, root_id, existing)
}

/// Derive the branch used for a Root.  It contains only Git-safe ASCII and is
/// deterministic for a provider Root ID.
pub fn root_branch_name(root_id: &str) -> Result<String, ResourceError> {
    validate_root_id(root_id)?;
    branch_name_from_slug(&stable_slug(root_id))
}

/// Derive the stable path component used for both workspace and run paths.
pub fn root_resource_slug(root_id: &str) -> Result<String, ResourceError> {
    validate_root_id(root_id)?;
    Ok(stable_slug(root_id))
}

fn canonical_repository(path: &Path) -> Result<PathBuf, ResourceError> {
    if !path.is_absolute() || !path.is_dir() {
        return Err(ResourceError::RepositoryInvalid);
    }
    let canonical = fs::canonicalize(path).map_err(|_| ResourceError::RepositoryInvalid)?;
    let top = git_output(&canonical, &["rev-parse", "--show-toplevel"])?;
    let top = PathBuf::from(top.trim());
    let top = fs::canonicalize(top).map_err(|_| ResourceError::RepositoryInvalid)?;
    if top != canonical {
        return Err(ResourceError::RepositoryInvalid);
    }
    let _ = git_output(&canonical, &["rev-parse", "--verify", "HEAD"])?;
    Ok(canonical)
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
    Ok(path.to_path_buf())
}

fn validate_existing_workspace(
    workspace: &Path,
    repository: &Path,
    branch: &str,
) -> Result<(), ResourceError> {
    if !workspace.is_absolute() || !workspace.is_dir() {
        return Err(ResourceError::ResourceMissing);
    }
    let workspace_top = git_output(workspace, &["rev-parse", "--show-toplevel"])?;
    let workspace_top =
        fs::canonicalize(workspace_top.trim()).map_err(|_| ResourceError::ResourceInvalid)?;
    if workspace_top != fs::canonicalize(workspace).map_err(|_| ResourceError::ResourceInvalid)? {
        return Err(ResourceError::AllocationMismatch);
    }
    let common_git_directory = git_output(workspace, &["rev-parse", "--git-common-dir"])?;
    let common_git_directory = fs::canonicalize(common_git_directory.trim())
        .map_err(|_| ResourceError::ResourceInvalid)?;
    let repository_git_directory =
        fs::canonicalize(repository.join(".git")).map_err(|_| ResourceError::ResourceInvalid)?;
    if common_git_directory != repository_git_directory {
        return Err(ResourceError::AllocationMismatch);
    }
    let current_branch = git_output(workspace, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    if current_branch.trim() != branch {
        return Err(ResourceError::AllocationMismatch);
    }
    Ok(())
}

fn validate_existing_run_directory(path: &Path) -> Result<(), ResourceError> {
    if !path.is_absolute() || !path.is_dir() {
        return Err(ResourceError::ResourceMissing);
    }
    let metadata = fs::metadata(path).map_err(|_| ResourceError::ResourceMissing)?;
    if metadata.permissions().readonly() {
        return Err(ResourceError::ResourceInvalid);
    }
    Ok(())
}

fn absolute_path(path: &Path) -> Result<PathBuf, ResourceError> {
    if !path.is_absolute() || path.to_string_lossy().contains('\0') {
        return Err(ResourceError::AllocationMismatch);
    }
    Ok(path.to_path_buf())
}

fn path_string(path: &Path) -> Result<String, ResourceError> {
    if !path.is_absolute() || path.to_string_lossy().contains('\0') {
        return Err(ResourceError::InvalidInput);
    }
    Ok(path.to_string_lossy().into_owned())
}

fn assert_within(root: &Path, child: &Path) -> Result<(), ResourceError> {
    if !child.starts_with(root) || child == root {
        return Err(ResourceError::AllocationMismatch);
    }
    Ok(())
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

fn validate_base_branch(branch: &str) -> Result<(), ResourceError> {
    if branch.is_empty()
        || branch.len() > 256
        || branch.starts_with('-')
        || branch.ends_with('.')
        || branch.ends_with('/')
        || branch.contains("..")
        || branch.contains("@{")
        || branch.chars().any(|ch| {
            ch.is_ascii_control()
                || ch == ' '
                || ch == '~'
                || ch == '^'
                || ch == ':'
                || ch == '?'
                || ch == '*'
                || ch == '['
                || ch == '\\'
        })
    {
        return Err(ResourceError::BaseBranchInvalid);
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

fn branch_name_from_slug(slug: &str) -> Result<String, ResourceError> {
    let branch = format!("symphony/{slug}");
    if branch.len() > MAX_BRANCH_LENGTH || branch.contains("..") || branch.contains("//") {
        return Err(ResourceError::InvalidInput);
    }
    Ok(branch)
}

fn fnv1a_hex(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn git_output(repository: &Path, args: &[&str]) -> Result<String, ResourceError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(args)
        .output()
        .map_err(|_| ResourceError::Git)?;
    if !output.status.success() {
        return Err(ResourceError::Git);
    }
    String::from_utf8(output.stdout).map_err(|_| ResourceError::Git)
}

#[cfg(test)]
mod tests {
    use super::*;
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
            // Test-owned temporary state is removed by the fixture only.  The
            // production allocator has no cleanup path.
            let _ = Command::new("git")
                .arg("worktree")
                .arg("remove")
                .arg("--force")
                .arg(self.path().join("app/workspaces/root"))
                .output();
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn binding(repository: &Path) -> ProjectBinding {
        ProjectBinding {
            project_id: "project-1".into(),
            routing_label: "core".into(),
            repository_path: repository.to_string_lossy().into_owned(),
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
        }
    }

    fn git(repository: &Path, args: &[&str]) {
        let output = Command::new("git").arg("-C").arg(repository).args(args).output().unwrap();
        assert!(output.status.success(), "git fixture command failed: {:?}", args);
    }

    fn fixture_repo(temp: &TempDir) -> PathBuf {
        let repository = temp.path().join("repo");
        fs::create_dir_all(&repository).unwrap();
        git(&repository, &["init", "-q", "-b", "main"]);
        git(&repository, &["config", "user.email", "fixture@example.invalid"]);
        git(&repository, &["config", "user.name", "Fixture"]);
        fs::write(repository.join("README.md"), "fixture\n").unwrap();
        git(&repository, &["add", "README.md"]);
        git(&repository, &["commit", "-qm", "initial"]);
        repository
    }

    #[test]
    fn first_allocation_uses_real_worktree_and_external_run_directory() {
        let temp = TempDir::new("first");
        let repository = fixture_repo(&temp);
        let app_data = temp.path().join("app");
        let allocator = RootResourceAllocator::new(&app_data);
        let binding = binding(&repository);

        let allocation = allocator.allocate(&binding, "issue-123", None).unwrap();

        assert_eq!(allocation.root_id, "issue-123");
        assert!(Path::new(&allocation.workspace_path).is_dir());
        assert!(Path::new(&allocation.run_directory).is_dir());
        assert!(Path::new(&allocation.workspace_path).starts_with(&app_data));
        assert!(Path::new(&allocation.run_directory).starts_with(&app_data));
        assert_eq!(
            git_output(Path::new(&allocation.workspace_path), &["symbolic-ref", "--short", "HEAD"])
                .unwrap()
                .trim(),
            root_branch_name("issue-123").unwrap()
        );
        assert_eq!(
            git_output(Path::new(&allocation.workspace_path), &["rev-parse", "--show-toplevel"])
                .unwrap()
                .trim(),
            fs::canonicalize(&allocation.workspace_path).unwrap().to_string_lossy()
        );
    }

    #[test]
    fn persisted_allocation_is_reused_exactly_after_restart() {
        let temp = TempDir::new("reuse");
        let repository = fixture_repo(&temp);
        let app_data = temp.path().join("app");
        let binding = binding(&repository);
        let first =
            RootResourceAllocator::new(&app_data).allocate(&binding, "issue-123", None).unwrap();
        let second = RootResourceAllocator::new(&app_data)
            .allocate(&binding, "issue-123", Some(&first))
            .unwrap();
        assert_eq!(second, first);
    }

    #[test]
    fn mismatched_or_missing_existing_allocation_fails_closed_without_replacement() {
        let temp = TempDir::new("mismatch");
        let repository = fixture_repo(&temp);
        let app_data = temp.path().join("app");
        let binding = binding(&repository);
        let allocator = RootResourceAllocator::new(&app_data);
        let first = allocator.allocate(&binding, "issue-123", None).unwrap();

        let wrong_id = RootAllocation { root_id: "other".into(), ..first.clone() };
        assert_eq!(
            allocator.allocate(&binding, "issue-123", Some(&wrong_id)),
            Err(ResourceError::AllocationMismatch)
        );

        let wrong_workspace = RootAllocation {
            workspace_path: temp.path().join("other").to_string_lossy().into_owned(),
            ..first.clone()
        };
        assert_eq!(
            allocator.allocate(&binding, "issue-123", Some(&wrong_workspace)),
            Err(ResourceError::AllocationMismatch)
        );

        let missing_run = RootAllocation {
            run_directory: app_data.join("runs/missing").to_string_lossy().into_owned(),
            ..first.clone()
        };
        assert_eq!(
            allocator.allocate(&binding, "issue-123", Some(&missing_run)),
            Err(ResourceError::ResourceMissing)
        );
        assert!(Path::new(&first.workspace_path).exists());
    }

    #[test]
    fn branch_and_path_names_are_safe_and_stable() {
        let first = root_branch_name("TEAM/123 unsafe").unwrap();
        let second = root_branch_name("TEAM/123 unsafe").unwrap();
        assert_eq!(first, second);
        assert!(first.starts_with("symphony/"));
        assert!(!first.contains(' '));
        assert!(!first.contains(".."));
        assert!(root_resource_slug("TEAM/123 unsafe")
            .unwrap()
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.')));
        assert_eq!(root_branch_name("bad\nroot"), Err(ResourceError::InvalidInput));
    }

    #[test]
    fn app_data_inside_repository_is_rejected_before_worktree_creation() {
        let temp = TempDir::new("overlap");
        let repository = fixture_repo(&temp);
        let binding = binding(&repository);
        let app_data = repository.join(".symphony-data");

        let result = RootResourceAllocator::new(app_data).allocate(&binding, "issue-123", None);

        assert_eq!(result, Err(ResourceError::AppDataRootInvalid));
        assert!(!repository.join(".symphony-data/workspaces").exists());
    }
}
