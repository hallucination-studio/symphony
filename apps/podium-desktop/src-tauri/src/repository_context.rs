use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, PartialEq, Eq)]
pub enum RepositoryError {
    CanonicalizeFailed,
    GitUnavailable,
    NotGitRepository,
    InvalidGitOutput,
    BaseBranchMissing,
    InvalidSelectedPath,
}

pub fn select_repository<R, F>(app: &AppHandle<R>, callback: F)
where
    R: Runtime,
    F: FnOnce(Result<Option<RepositoryContext>, RepositoryError>) + Send + 'static,
{
    app.dialog().file().pick_folder(move |selection| {
        let selected_path = selection
            .map(|path| path.into_path().map_err(|_| RepositoryError::InvalidSelectedPath))
            .transpose();
        callback(selected_path.and_then(inspect_selection));
    });
}

fn inspect_selection(path: Option<PathBuf>) -> Result<Option<RepositoryContext>, RepositoryError> {
    path.map(|path| inspect_repository(&path)).transpose()
}

pub fn validate_base_branch(
    repository: &RepositoryContext,
    base_branch: &str,
) -> Result<(), RepositoryError> {
    if repository.base_branches.iter().any(|candidate| candidate == base_branch) {
        Ok(())
    } else {
        Err(RepositoryError::BaseBranchMissing)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct RepositoryContext {
    pub repository_handle: String,
    pub canonical_path: PathBuf,
    pub display_name: OsString,
    pub remote_display: String,
    pub base_branches: Vec<String>,
}

pub fn inspect_repository(path: &Path) -> Result<RepositoryContext, RepositoryError> {
    let canonical_path =
        std::fs::canonicalize(path).map_err(|_| RepositoryError::CanonicalizeFailed)?;
    let top_level = git(&canonical_path, &["rev-parse", "--show-toplevel"])?;
    let git_root =
        std::fs::canonicalize(top_level.trim()).map_err(|_| RepositoryError::NotGitRepository)?;
    if git_root != canonical_path {
        return Err(RepositoryError::NotGitRepository);
    }

    let common_dir =
        git(&canonical_path, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    let repository_handle = hex::encode(Sha256::digest(common_dir.trim().as_bytes()));
    let remote = git_optional(&canonical_path, &["remote", "get-url", "origin"])
        .unwrap_or_else(|| "local repository".to_owned());
    let mut base_branches = local_branches(&canonical_path)?;
    if base_branches.is_empty() {
        if let Some(unborn) = git_optional(&canonical_path, &["symbolic-ref", "--short", "HEAD"]) {
            base_branches.push(unborn);
        }
    }

    let display_name =
        canonical_path.file_name().ok_or(RepositoryError::InvalidGitOutput)?.to_owned();
    Ok(RepositoryContext {
        repository_handle,
        canonical_path,
        display_name,
        remote_display: sanitize_remote(&remote),
        base_branches,
    })
}

fn git(path: &Path, args: &[&str]) -> Result<String, RepositoryError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|_| RepositoryError::GitUnavailable)?;
    if !output.status.success() {
        return Err(RepositoryError::NotGitRepository);
    }
    String::from_utf8(output.stdout).map_err(|_| RepositoryError::InvalidGitOutput)
}

fn git_optional(path: &Path, args: &[&str]) -> Option<String> {
    git(path, args).ok().map(|value| value.trim().to_owned()).filter(|value| !value.is_empty())
}

fn local_branches(path: &Path) -> Result<Vec<String>, RepositoryError> {
    let output = git(path, &["for-each-ref", "--format=%(refname:short)", "refs/heads/"])?;
    let mut branches: Vec<_> = output
        .lines()
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
        .map(str::to_owned)
        .collect();
    branches.sort();
    Ok(branches)
}

fn sanitize_remote(remote: &str) -> String {
    let trimmed = remote.trim().trim_end_matches(".git").trim_end_matches('/');
    if let Ok(url) = url::Url::parse(trimmed) {
        if matches!(url.scheme(), "https" | "http") {
            let host = url.host_str().unwrap_or("local repository");
            return format!("{host}{}", url.path()).trim_end_matches('/').to_owned();
        }
    }
    if let Some((user_host, repository)) = trimmed.split_once(':') {
        if let Some((_, host)) = user_host.rsplit_once('@') {
            return format!("{host}/{repository}");
        }
    }
    "local repository".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    #[test]
    fn resolves_a_canonical_git_repository_and_local_base_branches() {
        let temp = std::env::temp_dir()
            .join(format!("symphony-repository-context-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();
        assert!(Command::new("git")
            .args(["init", "-b", "main"])
            .arg(&temp)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args([
                "-C",
                temp.to_str().unwrap(),
                "remote",
                "add",
                "origin",
                "https://github.com/acme/example.git"
            ])
            .status()
            .unwrap()
            .success());

        let result = inspect_repository(&temp).unwrap();

        assert_eq!(result.canonical_path, fs::canonicalize(&temp).unwrap());
        assert_eq!(result.display_name, temp.file_name().unwrap());
        assert_eq!(result.remote_display, "github.com/acme/example");
        assert_eq!(result.base_branches, vec!["main"]);
        assert!(!result.repository_handle.contains(temp.to_str().unwrap()));
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn rejects_a_non_git_directory() {
        let temp =
            std::env::temp_dir().join(format!("symphony-not-repository-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();

        assert_eq!(inspect_repository(&temp).unwrap_err(), RepositoryError::NotGitRepository);
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn validates_the_selected_base_branch_against_the_inspected_repository() {
        let repository = RepositoryContext {
            repository_handle: "opaque".to_owned(),
            canonical_path: PathBuf::from("/repository"),
            display_name: OsString::from("repository"),
            remote_display: "github.com/acme/repository".to_owned(),
            base_branches: vec!["main".to_owned()],
        };

        assert_eq!(validate_base_branch(&repository, "main"), Ok(()));
        assert_eq!(
            validate_base_branch(&repository, "missing"),
            Err(RepositoryError::BaseBranchMissing)
        );
    }

    #[test]
    fn remote_display_never_exposes_embedded_credentials() {
        assert_eq!(
            sanitize_remote("https://user:password@github.com/acme/example.git"),
            "github.com/acme/example"
        );
        assert_eq!(sanitize_remote("git@github.com:acme/example.git"), "github.com/acme/example");
    }

    #[test]
    fn canceled_native_selection_returns_no_repository_context() {
        assert_eq!(inspect_selection(None), Ok(None));
    }
}
