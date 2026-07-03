from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
from typing import Any

from performer_api.ops_models import RepositoryHandoffReport

TEXT_PREVIEW_LIMIT = 4096


def build_repository_handoff_report(
    *,
    issue_id: str,
    issue_identifier: str,
    workspace_path: Path,
    structured_result: dict[str, Any] | None,
    bundle_root: Path,
) -> RepositoryHandoffReport:
    generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    bundle_path = _bundle_path(bundle_root, issue_identifier, generated_at)
    bundle_path.mkdir(parents=True, exist_ok=True)

    git_snapshot = git_snapshot_for_workspace(workspace_path)
    patch_path = bundle_path / "changes.patch"
    patch_path.write_bytes(_git_diff(workspace_path) if git_snapshot["is_git_repo"] else b"")
    untracked_manifest = _copy_untracked_files(workspace_path, bundle_path, git_snapshot)
    manifest = _artifact_manifest(bundle_path)
    for item in untracked_manifest:
        for manifest_item in manifest:
            if manifest_item["path"] == item["path"]:
                manifest_item["source_path"] = item["source_path"]
                break
    manifest_path = bundle_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")

    bundle = {
        "type": "local_bundle",
        "path": str(bundle_path),
        "changes_patch_path": str(patch_path),
        "manifest_path": str(manifest_path),
        "untracked_path": str(bundle_path / "untracked"),
    }
    return RepositoryHandoffReport(
        issue_id=issue_id,
        issue_identifier=issue_identifier,
        workspace_path=str(workspace_path),
        structured_result=structured_result,
        git_snapshot=git_snapshot,
        artifact_manifest=manifest,
        bundle=bundle,
        recommended_next_action=(
            "create_repository_integration_issue"
            if git_snapshot["is_git_repo"]
            else "manual_integration_review"
        ),
        generated_at=generated_at,
    )


def git_snapshot_for_workspace(workspace_path: Path) -> dict[str, Any]:
    if _git(workspace_path, "rev-parse", "--is-inside-work-tree").returncode != 0:
        files = sorted(str(path.relative_to(workspace_path)) for path in workspace_path.rglob("*") if path.is_file())
        return {
            "is_git_repo": False,
            "repo_root": None,
            "is_worktree": False,
            "branch": None,
            "head_sha": None,
            "upstream": None,
            "status_porcelain": "",
            "diff_stat": "",
            "changed_files": files,
            "untracked_files": files,
        }
    repo_root = _git_text(workspace_path, "rev-parse", "--show-toplevel")
    git_dir = _git_text(workspace_path, "rev-parse", "--git-dir")
    common_dir = _git_text(workspace_path, "rev-parse", "--git-common-dir")
    status = _git_output(workspace_path, "status", "--porcelain=v1").rstrip("\n")
    untracked = _git_lines(workspace_path, "ls-files", "--others", "--exclude-standard")
    changed = _changed_files_from_status(status)
    return {
        "is_git_repo": True,
        "repo_root": repo_root,
        "is_worktree": bool(git_dir and common_dir and Path(git_dir).resolve() != Path(common_dir).resolve()),
        "branch": _git_text(workspace_path, "branch", "--show-current") or None,
        "head_sha": _git_text(workspace_path, "rev-parse", "HEAD") or None,
        "upstream": _git_text(workspace_path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}") or None,
        "status_porcelain": status,
        "diff_stat": _git_text(workspace_path, "diff", "--stat", "HEAD", "--"),
        "changed_files": changed,
        "untracked_files": untracked,
    }


def _bundle_path(bundle_root: Path, issue_identifier: str, generated_at: str) -> Path:
    safe_identifier = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in issue_identifier)
    safe_timestamp = generated_at.replace(":", "").replace(".", "-")
    return bundle_root / safe_identifier / safe_timestamp


def _git(workspace_path: Path, *args: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", "-C", str(workspace_path), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def _git_text(workspace_path: Path, *args: str) -> str:
    return _git_output(workspace_path, *args).strip()


def _git_output(workspace_path: Path, *args: str) -> str:
    result = _git(workspace_path, *args)
    if result.returncode != 0:
        return ""
    return result.stdout.decode("utf-8", errors="replace")


def _git_lines(workspace_path: Path, *args: str) -> list[str]:
    text = _git_text(workspace_path, *args)
    return [line for line in text.splitlines() if line]


def _git_diff(workspace_path: Path) -> bytes:
    result = _git(workspace_path, "diff", "--binary", "--full-index", "HEAD", "--")
    return result.stdout if result.returncode == 0 else b""


def _changed_files_from_status(status: str) -> list[str]:
    changed: list[str] = []
    for line in status.splitlines():
        if not line:
            continue
        path = line[3:] if len(line) > 3 else line
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        changed.append(path)
    return changed


def _copy_untracked_files(
    workspace_path: Path,
    bundle_path: Path,
    git_snapshot: dict[str, Any],
) -> list[dict[str, str]]:
    copied: list[dict[str, str]] = []
    untracked = git_snapshot.get("untracked_files")
    if not isinstance(untracked, list):
        return copied
    for relative in untracked:
        if not isinstance(relative, str) or not relative:
            continue
        source = workspace_path / relative
        if not source.is_file():
            continue
        target = bundle_path / "untracked" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied.append({"path": str(target.relative_to(bundle_path)), "source_path": str(source)})
    return copied


def _artifact_manifest(bundle_path: Path) -> list[dict[str, Any]]:
    manifest: list[dict[str, Any]] = []
    for path in sorted(item for item in bundle_path.rglob("*") if item.is_file()):
        relative = str(path.relative_to(bundle_path))
        item: dict[str, Any] = {
            "path": relative,
            "size": path.stat().st_size,
            "sha256": _sha256(path),
        }
        preview = _text_preview(path)
        if preview is not None:
            item["preview"] = preview
        manifest.append(item)
    return manifest


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _text_preview(path: Path) -> str | None:
    if path.stat().st_size > TEXT_PREVIEW_LIMIT:
        return None
    data = path.read_bytes()
    if b"\0" in data:
        return None
    return data.decode("utf-8", errors="replace")
