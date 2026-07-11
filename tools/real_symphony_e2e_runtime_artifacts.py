from __future__ import annotations

from pathlib import Path
from typing import Any

from real_symphony_e2e_common import Evidence
from runtime_claims_audit import audit_runtime_evidence
from runtime_evidence_archive import (
    artifact_hashes,
    new_staging_directory,
    publish_directory,
    remove_staging_directory,
    stage_runtime_evidence,
    write_private_json,
)
from runtime_evidence_files import attempt_artifacts, copy_sanitized_file, generation_log_paths, managed_run_db_path


CATEGORY_FAILURE_PREFIXES = {
    "generation-logs": ("generation_log_", "generation_logs_missing"),
    "attempt-logs": ("attempt_log_", "attempt_logs_missing"),
    "turn-requests": ("turn_request_", "turn_requests_missing"),
    "turn-results": ("turn_result_", "turn_results_missing"),
}


def archive_managed_run_artifacts(*, evidence: Evidence, root: Path, data_root: Path, instance_id: str) -> None:
    _register_final_views(evidence, root)
    archive_root = root / "runtime-artifacts"
    staging = new_staging_directory(archive_root)
    try:
        runtime_copy = stage_runtime_evidence(data_root, instance_id=instance_id, destination=staging)
        service_logs = _stage_service_logs(root, staging, runtime_copy["failures"])
        audit = audit_runtime_evidence(staging, instance_id=instance_id)
        audit["managed_run_db"] = "managed_run/managed_run.db"
        write_private_json(staging / "runtime-claims-audit.json", audit)
        manifest = {
            "runtime_artifacts_pass": bool(audit["pass"] and not runtime_copy["failures"]),
            "instance_id": instance_id,
            "copied": runtime_copy["copied"],
            "service_logs": service_logs,
            "archive_failures": runtime_copy["failures"],
            "runtime_audit_failures": audit["failures"],
            "sha256": artifact_hashes(staging),
            "hash_scope": "all runtime artifact files except manifest.json",
        }
        write_private_json(staging / "manifest.json", manifest)
        publish_directory(staging, archive_root)
    except Exception as exc:
        evidence.check(
            "runtime-artifacts:publish",
            False,
            error_code="runtime_artifact_publish_failed",
            sanitized_reason=type(exc).__name__,
            action_required="inspect_runtime_artifact_archive",
            retryable=False,
            next_action="repair_archive_destination_and_rerun",
        )
        return
    finally:
        remove_staging_directory(staging)

    _register_archive_artifacts(evidence, archive_root, instance_id)
    _record_service_log_checks(evidence, service_logs, root)
    _record_copy_failures(evidence, runtime_copy["failures"])
    _record_runtime_category_checks(evidence, runtime_copy["copied"], audit)
    if audit["pass"] and not runtime_copy["failures"]:
        evidence.check("runtime-artifacts:audit", True, counts=audit["counts"])
    else:
        evidence.check(
            "runtime-artifacts:audit",
            False,
            error_code="runtime_evidence_audit_failed",
            sanitized_reason="archived Managed Run runtime evidence is incomplete or invalid",
            action_required="inspect_runtime_claims_audit",
            retryable=False,
            next_action="fix_runtime_evidence_and_rerun",
            failures=audit["failures"],
        )


def _stage_service_logs(root: Path, staging: Path, failures: list[dict[str, str]]) -> dict[str, str]:
    statuses: dict[str, str] = {}
    for name, filename, required in (
        ("podium_log", "podium.log", True),
        ("conductor_log", "conductor.log", True),
        ("conductor_restarted_log", "conductor-restarted.log", False),
    ):
        source = root / filename
        if not source.is_file():
            statuses[name] = "missing" if required else "not_applicable"
            continue
        try:
            copy_sanitized_file(source, staging / "service_logs" / filename)
        except OSError as exc:
            statuses[name] = "archive_failed"
            failures.append(
                {
                    "artifact": name,
                    "error_code": "runtime_artifact_archive_failed",
                    "sanitized_reason": type(exc).__name__,
                }
            )
        else:
            statuses[name] = "copied"
    return statuses


def _register_final_views(evidence: Evidence, root: Path) -> None:
    for name, path in {
        "final_managed_runs_view": root / "final-managed-runs-view.json",
        "final_linear_tree_audit": root / "final-linear-tree-audit.json",
        "final_issue_tree": root / "final-issue-tree.json",
    }.items():
        if path.is_file():
            evidence.artifact(name, path)


def _register_archive_artifacts(evidence: Evidence, archive_root: Path, instance_id: str) -> None:
    db_path = managed_run_db_path(archive_root)
    if db_path.is_file():
        evidence.artifact("managed_run_db", db_path)
    for name, filename in (
        ("podium_log", "podium.log"),
        ("conductor_log", "conductor.log"),
        ("conductor_restarted_log", "conductor-restarted.log"),
    ):
        path = archive_root / "service_logs" / filename
        if path.is_file():
            evidence.artifact(name, path)
    instance_root = archive_root / "instances" / instance_id
    for source in generation_log_paths(instance_root):
        generation = source.stem.rsplit("-", 1)[-1]
        evidence.artifact(f"instance_log_generation_{generation}", source)
    for attempt in attempt_artifacts(instance_root):
        safe_attempt = attempt.attempt_id.replace("/", "_")
        if attempt.request is not None:
            evidence.artifact(f"attempt_{safe_attempt}_request", attempt.request)
        if attempt.result is not None:
            evidence.artifact(f"attempt_{safe_attempt}_result", attempt.result)
        if attempt.log is not None:
            evidence.artifact(f"attempt_{safe_attempt}_log", attempt.log)
    evidence.artifact("runtime_claims_audit", archive_root / "runtime-claims-audit.json")
    evidence.artifact("runtime_artifacts_manifest", archive_root / "manifest.json")


def _record_service_log_checks(evidence: Evidence, statuses: dict[str, str], root: Path) -> None:
    for name in ("podium_log", "conductor_log"):
        status = statuses[name]
        check_name = name.replace("_", "-")
        if status == "copied":
            evidence.check(f"runtime-artifacts:{check_name}", True)
        else:
            _required_artifact_check(evidence, check_name, root / f"{name.removesuffix('_log')}.log")


def _record_copy_failures(evidence: Evidence, failures: list[dict[str, str]]) -> None:
    for failure in failures:
        artifact = str(failure["artifact"]).replace("_", "-").replace(":", "-")
        evidence.check(
            f"runtime-artifacts:{artifact}:archive",
            False,
            error_code=failure["error_code"],
            sanitized_reason=failure["sanitized_reason"],
            action_required="inspect_runtime_artifact",
            retryable=False,
            next_action="repair_or_rerun_managed_run",
        )


def _record_runtime_category_checks(evidence: Evidence, copied: dict[str, Any], audit: dict[str, Any]) -> None:
    if copied["managed_run_db"]:
        evidence.check("runtime-artifacts:managed-run-db", True)
    else:
        _required_artifact_check(evidence, "managed-run-db", Path("managed_run/managed_run.db"))
    for name, count_key in (
        ("generation-logs", "generation_logs"),
        ("attempt-logs", "attempt_logs"),
        ("turn-requests", "turn_requests"),
        ("turn-results", "turn_results"),
    ):
        related = [
            failure
            for failure in audit["failures"]
            if str(failure).startswith(CATEGORY_FAILURE_PREFIXES[name])
        ]
        count = int(copied[count_key])
        if count and not related:
            evidence.check(f"runtime-artifacts:{name}", True, count=count)
        elif not count:
            _required_artifact_check(evidence, name, Path(f"instances/*/{name}"))
        else:
            evidence.check(
                f"runtime-artifacts:{name}",
                False,
                error_code="runtime_artifact_validation_failed",
                sanitized_reason=f"archived {name} evidence is invalid",
                action_required="inspect_runtime_claims_audit",
                retryable=False,
                next_action="repair_or_rerun_managed_run",
                failures=related,
            )


def _required_artifact_check(evidence: Evidence, name: str, expected_path: Path) -> None:
    evidence.check(
        f"runtime-artifacts:{name}",
        False,
        error_code="required_runtime_artifact_missing",
        sanitized_reason=f"required {name} evidence is missing",
        action_required="inspect_runtime_startup_and_artifact_collection",
        retryable=False,
        next_action="fix_missing_runtime_evidence_and_rerun",
        expected_path=str(expected_path),
    )


__all__ = ["archive_managed_run_artifacts"]
