from __future__ import annotations

import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
from typing import Any
from uuid import uuid4

from runtime_evidence_files import (
    UnsafeEvidenceError,
    attempt_artifacts,
    copy_sanitized_file,
    generation_log_paths,
    managed_run_db_path,
    sha256_file,
    snapshot_sqlite,
)


def stage_runtime_evidence(data_root: Path, *, instance_id: str, destination: Path) -> dict[str, Any]:
    instance_root = data_root / "instances" / instance_id
    copied: dict[str, Any] = {
        "managed_run_db": False,
        "generation_logs": 0,
        "attempt_logs": 0,
        "turn_requests": 0,
        "turn_results": 0,
    }
    failures: list[dict[str, str]] = []
    source_db = managed_run_db_path(data_root)
    if source_db.is_file():
        try:
            snapshot_sqlite(source_db, managed_run_db_path(destination))
        except UnsafeEvidenceError as exc:
            failures.append(
                {
                    "artifact": "managed_run_db",
                    "error_code": "runtime_artifact_contains_secret",
                    "sanitized_reason": "unsafe secret material found in " + ",".join(exc.locations),
                }
            )
        except (OSError, sqlite3.Error) as exc:
            failures.append(_archive_failure("managed_run_db", exc))
        else:
            copied["managed_run_db"] = True

    target_instance = destination / "instances" / instance_id
    for source in generation_log_paths(instance_root):
        if _copy(source, target_instance / "logs" / source.name, failures, "generation_log"):
            copied["generation_logs"] += 1
    for attempt in attempt_artifacts(instance_root):
        target_attempt = target_instance / "state" / "managed_run" / attempt.attempt_id
        if attempt.request is not None and _copy(
            attempt.request,
            target_attempt / "turn-request.json",
            failures,
            f"turn_request:{attempt.attempt_id}",
        ):
            copied["turn_requests"] += 1
        if attempt.result is not None and _copy(
            attempt.result,
            target_attempt / "turn-result.json",
            failures,
            f"turn_result:{attempt.attempt_id}",
        ):
            copied["turn_results"] += 1
        if attempt.log is not None and _copy(
            attempt.log,
            target_attempt / "attempt.log",
            failures,
            f"attempt_log:{attempt.attempt_id}",
        ):
            copied["attempt_logs"] += 1
    return {"copied": copied, "failures": failures}


def new_staging_directory(target: Path) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=f".{target.name}.tmp-", dir=target.parent))


def publish_directory(staging: Path, target: Path) -> None:
    backup = target.with_name(f".{target.name}.backup-{uuid4().hex}")
    moved_existing = False
    try:
        if target.exists():
            target.replace(backup)
            moved_existing = True
        staging.replace(target)
    except Exception:
        if moved_existing and backup.exists() and not target.exists():
            backup.replace(target)
        raise
    finally:
        if backup.exists():
            shutil.rmtree(backup)


def remove_staging_directory(staging: Path) -> None:
    if staging.exists():
        shutil.rmtree(staging)


def artifact_hashes(root: Path, *, exclude: set[str] | None = None) -> dict[str, str]:
    excluded = exclude or set()
    return {
        relative: sha256_file(path)
        for path in sorted(root.rglob("*"))
        if path.is_file() and (relative := path.relative_to(root).as_posix()) not in excluded
    }


def write_private_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.unlink(missing_ok=True)
    try:
        temporary.touch(mode=0o600)
        temporary.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
        temporary.replace(path)
        path.chmod(0o600)
    finally:
        temporary.unlink(missing_ok=True)


def _copy(
    source: Path,
    target: Path,
    failures: list[dict[str, str]],
    artifact: str,
) -> bool:
    try:
        copy_sanitized_file(source, target)
    except OSError as exc:
        failures.append(_archive_failure(artifact, exc))
        return False
    return True


def _archive_failure(artifact: str, exc: Exception) -> dict[str, str]:
    return {
        "artifact": artifact,
        "error_code": "runtime_artifact_archive_failed",
        "sanitized_reason": type(exc).__name__,
    }


__all__ = [
    "artifact_hashes",
    "new_staging_directory",
    "publish_directory",
    "remove_staging_directory",
    "stage_runtime_evidence",
    "write_private_json",
]
