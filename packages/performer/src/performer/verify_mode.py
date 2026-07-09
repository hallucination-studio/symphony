from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from performer_api.pipeline import GateSpecSnapshot, GateStepSource, PASS_THRESHOLD, RuntimeMode

from .mode_common import (
    _fencing_fields,
    _file_sha256,
    _git,
    _optional_payload_str,
    _payload_kind,
    _run,
    _sanitize_error,
)


def _run_verify_mode(payload: dict[str, object]) -> dict[str, object]:
    verification_input = payload.get("verification_input")
    if not isinstance(verification_input, dict):
        raise RuntimeError("verify mode requires verification_input")
    gate_snapshot_payload = payload.get("gate_snapshot")
    gate_snapshot = GateSpecSnapshot.from_dict(gate_snapshot_payload) if isinstance(gate_snapshot_payload, dict) else None
    gate_hash = str(payload.get("gate_snapshot_hash") or verification_input.get("gate_snapshot_hash") or "")
    if gate_snapshot is None or not gate_snapshot.frozen or not gate_hash:
        return _failed_verify_result(payload, verification_input, gate_hash, "frozen_gate_required")
    if gate_snapshot is not None and gate_snapshot.hash != gate_hash:
        return _failed_verify_result(payload, verification_input, gate_hash, "gate_snapshot_hash_mismatch")
    if str(verification_input.get("gate_snapshot_hash") or "") != gate_hash:
        return _failed_verify_result(payload, verification_input, gate_hash, "gate_snapshot_hash_mismatch")
    forced_failure = _forced_first_verify_failure_reason()
    if forced_failure is not None:
        return _failed_gate_verify_result(payload, verification_input, gate_hash, forced_failure)
    patch_verification = _verify_patch_hash(verification_input)
    if patch_verification.reason is not None:
        return _failed_verify_result(payload, verification_input, gate_hash, patch_verification.reason)
    artifact_mismatch = _verify_artifact_hashes(verification_input)
    if artifact_mismatch is not None:
        return _failed_verify_result(payload, verification_input, gate_hash, artifact_mismatch)
    command_failure = _run_gate_commands(gate_snapshot, verification_input, verification_workspace=patch_verification.workspace)
    if command_failure is not None:
        return _failed_verify_result(payload, verification_input, gate_hash, command_failure)
    return {
        "attempt_id": str(payload.get("attempt_id") or "verify-attempt"),
        "node_id": str(payload.get("node_id") or verification_input.get("task_id") or ""),
        "execute_attempt_id": str(payload.get("execute_attempt_id") or verification_input.get("execute_attempt_id") or ""),
        "mode": RuntimeMode.VERIFY.value,
        "status": "succeeded",
        **_fencing_fields(payload),
        "score": PASS_THRESHOLD,
        "passed": True,
        "gate_snapshot_hash": gate_hash,
        "verification_input": dict(verification_input),
        "kind": _payload_kind(payload, default="local-verifier"),
    }


def _failed_verify_result(
    payload: dict[str, object],
    verification_input: dict[str, object],
    gate_hash: str,
    reason: str,
) -> dict[str, object]:
    sanitized_reason = reason.replace("\x00", "").strip()[:500] or "verify_failed"
    return {
        "attempt_id": str(payload.get("attempt_id") or "verify-attempt"),
        "node_id": str(payload.get("node_id") or verification_input.get("task_id") or ""),
        "execute_attempt_id": str(payload.get("execute_attempt_id") or verification_input.get("execute_attempt_id") or ""),
        "mode": RuntimeMode.VERIFY.value,
        "status": "failed",
        **_fencing_fields(payload),
        "gate_snapshot_hash": gate_hash,
        "score": 0,
        "passed": False,
        "reason": sanitized_reason,
        "error": sanitized_reason,
        "kind": _payload_kind(payload, default="local-verifier"),
    }


def _failed_gate_verify_result(
    payload: dict[str, object],
    verification_input: dict[str, object],
    gate_hash: str,
    reason: str,
) -> dict[str, object]:
    sanitized_reason = reason.replace("\x00", "").strip()[:500] or "verify_failed"
    return {
        "attempt_id": str(payload.get("attempt_id") or "verify-attempt"),
        "node_id": str(payload.get("node_id") or verification_input.get("task_id") or ""),
        "execute_attempt_id": str(payload.get("execute_attempt_id") or verification_input.get("execute_attempt_id") or ""),
        "mode": RuntimeMode.VERIFY.value,
        "status": "succeeded",
        **_fencing_fields(payload),
        "gate_snapshot_hash": gate_hash,
        "score": 0,
        "passed": False,
        "error": sanitized_reason,
        "verification_input": dict(verification_input),
        "kind": _payload_kind(payload, default="local-verifier"),
    }


def _forced_first_verify_failure_reason() -> str | None:
    if os.environ.get("SYMPHONY_FORCE_FIRST_VERIFY_FAILURE_FOR_REPLAN") != "1":
        return None
    verifier_home = (
        os.environ.get("SYMPHONY_LOCAL_VERIFIER_PROBE_HOME", "").strip()
        or os.environ.get("SYMPHONY_LOCAL_VERIFIER_HOME", "").strip()
    )
    if not verifier_home:
        return None
    marker = Path(verifier_home) / "forced-first-verify-failure-for-replan.done"
    if marker.exists():
        return None
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("forced_first_verify_failure_for_replan\n", encoding="utf-8")
    return "forced_first_verify_failure_for_replan"


class _PatchVerificationResult:
    def __init__(self, *, reason: str | None = None, workspace: Path | None = None):
        self.reason = reason
        self.workspace = workspace


def _verify_patch_hash(verification_input: dict[str, object]) -> _PatchVerificationResult:
    commit_sha = _optional_payload_str(verification_input.get("commit_sha"))
    if commit_sha:
        workspace = _optional_payload_str(verification_input.get("workspace_path")) or _optional_payload_str(
            verification_input.get("repository_path")
        )
        if not workspace:
            return _PatchVerificationResult(reason="commit_unavailable")
        verify_workspace = _commit_verify_workspace(verification_input, fallback_parent=Path(workspace))
        if verify_workspace.exists():
            shutil.rmtree(verify_workspace)
        try:
            verify_workspace.parent.mkdir(parents=True, exist_ok=True)
            _git(["worktree", "add", "--detach", "--quiet", str(verify_workspace), commit_sha], cwd=Path(workspace))
        except (subprocess.SubprocessError, OSError):
            return _PatchVerificationResult(reason="verification_workspace_unavailable")
        return _PatchVerificationResult(workspace=verify_workspace)
    patch_uri = str(verification_input.get("patch_uri") or "")
    expected_hash = str(verification_input.get("patch_hash") or "")
    if not patch_uri.startswith("file://") or not expected_hash.startswith("sha256:"):
        return _PatchVerificationResult(reason="patch_unavailable")
    patch_path = Path(patch_uri.removeprefix("file://"))
    try:
        data = patch_path.read_bytes()
    except OSError:
        return _PatchVerificationResult(reason="patch_unavailable")
    actual = "sha256:" + hashlib.sha256(data).hexdigest()
    if actual != expected_hash:
        return _PatchVerificationResult(reason="patch_hash_mismatch")
    workspace = _optional_payload_str(verification_input.get("repository_path"))
    base_revision = _optional_payload_str(verification_input.get("base_revision"))
    expected_tree = _optional_payload_str(verification_input.get("expected_result_tree"))
    if not workspace or not base_revision or not expected_tree:
        return _PatchVerificationResult(reason="patch_unavailable")
    verify_workspace = patch_path.parent / "verify-worktree"
    if verify_workspace.exists():
        shutil.rmtree(verify_workspace)
    try:
        _git(["clone", "--quiet", workspace, str(verify_workspace)], cwd=Path(workspace))
        _git(["checkout", "--quiet", base_revision], cwd=verify_workspace)
    except (subprocess.SubprocessError, OSError):
        return _PatchVerificationResult(reason="verification_workspace_unavailable")
    if data:
        try:
            _run(["git", "apply", "--index", str(patch_path)], cwd=verify_workspace)
        except (subprocess.SubprocessError, OSError):
            return _PatchVerificationResult(reason="patch_apply_failed")
    try:
        actual_tree = _git(["write-tree"], cwd=verify_workspace).strip()
    except (subprocess.SubprocessError, OSError):
        return _PatchVerificationResult(reason="result_tree_unavailable")
    if actual_tree != expected_tree:
        return _PatchVerificationResult(reason="result_tree_mismatch")
    result_revision = _optional_payload_str(verification_input.get("result_revision"))
    if result_revision:
        try:
            result_revision_tree = _git(["rev-parse", f"{result_revision}^{{tree}}"], cwd=verify_workspace).strip()
        except subprocess.CalledProcessError:
            return _PatchVerificationResult(reason="result_revision_unavailable")
        if result_revision_tree != actual_tree:
            return _PatchVerificationResult(reason="result_revision_tree_mismatch")
    return _PatchVerificationResult(workspace=verify_workspace)


def _commit_verify_workspace(verification_input: dict[str, object], *, fallback_parent: Path) -> Path:
    evidence_uri = str(verification_input.get("evidence_uri") or "")
    if evidence_uri.startswith("file://"):
        return Path(evidence_uri.removeprefix("file://")).parent / "verify-worktree"
    attempt_id = _optional_payload_str(verification_input.get("execute_attempt_id")) or "verify"
    parent = fallback_parent / ".symphony" / "verify"
    parent.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=f"{attempt_id}-verify-", dir=str(parent)))


def _verify_artifact_hashes(verification_input: dict[str, object]) -> str | None:
    artifacts = verification_input.get("artifact_uris") or []
    if not isinstance(artifacts, list):
        return "artifact_unavailable"
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            return "artifact_unavailable"
        uri = str(artifact.get("uri") or "")
        expected_hash = str(artifact.get("sha256") or "")
        if not uri.startswith("file://") or not expected_hash.startswith("sha256:"):
            return "artifact_unavailable"
        path = Path(uri.removeprefix("file://"))
        try:
            actual_hash = _file_sha256(path)
        except OSError:
            return "artifact_unavailable"
        if actual_hash != expected_hash:
            return "artifact_hash_mismatch"
    return None


def _run_gate_commands(
    gate_snapshot: GateSpecSnapshot | None,
    verification_input: dict[str, object],
    *,
    verification_workspace: Path | None,
) -> str | None:
    if gate_snapshot is None:
        return None
    commands = gate_snapshot.content.verification_procedure
    if not commands:
        return "gate_command_failed"
    cwd = verification_workspace or _verification_command_cwd(verification_input)
    if cwd is None:
        return "gate_command_failed"
    baseline_status = ""
    baseline_tree = ""
    if verification_workspace is not None:
        try:
            baseline_status = _git(["status", "--porcelain"], cwd=verification_workspace).strip()
            baseline_tree = _git(["write-tree"], cwd=verification_workspace).strip()
        except (subprocess.SubprocessError, OSError):
            return "verifier_workspace_mutated"
    for command in commands:
        try:
            subprocess.run(
                command,
                cwd=cwd,
                shell=True,
                check=True,
                capture_output=True,
                text=True,
                timeout=300,
                env=_verification_command_env(),
            )
        except subprocess.CalledProcessError as exc:
            if command.source is GateStepSource.PLANNER_INFERRED:
                continue
            return _gate_command_failure_reason(command, exc)
        except subprocess.TimeoutExpired as exc:
            if command.source is GateStepSource.PLANNER_INFERRED:
                continue
            return _gate_command_failure_reason(command, exc)
        except (subprocess.SubprocessError, OSError) as exc:
            if command.source is GateStepSource.PLANNER_INFERRED:
                continue
            return _gate_command_failure_reason(command, exc)
    if verification_workspace is not None:
        try:
            status = _git(["status", "--porcelain"], cwd=verification_workspace).strip()
            actual_tree = _git(["write-tree"], cwd=verification_workspace).strip()
        except (subprocess.SubprocessError, OSError):
            return "verifier_workspace_mutated"
        if status != baseline_status or actual_tree != baseline_tree:
            return "verifier_workspace_mutated"
    return None


def _gate_command_failure_reason(command: str, exc: BaseException) -> str:
    parts = [f"gate_command_failed command={command!r}"]
    returncode = getattr(exc, "returncode", None)
    if returncode is not None:
        parts.append(f"exit_code={returncode}")
    stdout = getattr(exc, "stdout", None)
    stderr = getattr(exc, "stderr", None)
    parts.append(f"stdout={_single_line_tail(str(stdout or ''))!r}")
    parts.append(f"stderr={_single_line_tail(str(stderr or ''))!r}")
    if returncode is None:
        parts.append(f"error={_single_line_tail(str(exc))!r}")
    return _sanitize_error(" ".join(parts))


def _single_line_tail(value: str, *, limit: int = 240) -> str:
    text = " ".join(value.replace("\x00", "").split())
    return text[-limit:]


def _verification_command_env() -> dict[str, str]:
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    existing_pytest_addopts = env.get("PYTEST_ADDOPTS", "").strip()
    cache_disable = "-p no:cacheprovider"
    if cache_disable not in existing_pytest_addopts:
        env["PYTEST_ADDOPTS"] = f"{existing_pytest_addopts} {cache_disable}".strip()
    return env

def _verification_command_cwd(verification_input: dict[str, object]) -> Path | None:
    workspace = _optional_payload_str(verification_input.get("verification_workspace"))
    if workspace:
        return Path(workspace)
    repository_path = _optional_payload_str(verification_input.get("repository_path"))
    if repository_path:
        patch_uri = str(verification_input.get("patch_uri") or "")
        if patch_uri.startswith("file://"):
            verify_workspace = Path(patch_uri.removeprefix("file://")).parent / "verify-worktree"
            if verify_workspace.exists():
                return verify_workspace
        return Path(repository_path)
    return None
