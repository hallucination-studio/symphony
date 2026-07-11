from __future__ import annotations

import argparse
from contextlib import closing
import json
import sqlite3
from pathlib import Path
from typing import Any

from conductor.conductor_managed_run_attempts import attempt_integrity_errors, canonical_attempt_records
from performer_api.managed_runs import ManagedRunTurnContext
from runtime_evidence_files import (
    AttemptArtifacts,
    attempt_artifacts,
    copy_sanitized_file,
    generation_log_paths,
    latest_generation_log,
    managed_run_db_path,
    sanitize_evidence_value,
    sanitize_text,
    snapshot_sqlite,
)


REQUIRED_TABLES = (
    "managed_run_runs",
    "managed_run_plan_versions",
    "managed_run_work_items",
    "managed_run_linear_projections",
    "managed_run_checkpoint_results",
)


def audit_managed_run_db(db_path: Path, *, instance_id: str | None = None) -> dict[str, Any]:
    failures: list[str] = []
    if not db_path.is_file():
        return _db_audit_result(db_path, failures=["managed_run_db_missing"])
    try:
        with closing(sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)) as connection:
            connection.row_factory = sqlite3.Row
            integrity = str(connection.execute("PRAGMA quick_check").fetchone()[0])
            tables = {
                str(row[0])
                for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
            }
            missing_tables = [table for table in REQUIRED_TABLES if table not in tables]
            failures.extend(f"managed_run_table_missing:{table}" for table in missing_tables)
            if integrity != "ok":
                failures.append("managed_run_db_integrity_failed")
            if missing_tables:
                return _db_audit_result(db_path, failures=failures, integrity=integrity)
            query = (
                "SELECT run_id, issue_identifier, instance_id, state, plan_version, "
                "latest_reason, payload_json FROM managed_run_runs"
            )
            parameters: tuple[str, ...] = ()
            if instance_id:
                query += " WHERE instance_id = ?"
                parameters = (instance_id,)
            query += " ORDER BY created_at, run_id"
            rows = connection.execute(query, parameters).fetchall()
            runs, run_ids, attempts = _safe_run_rows(rows, failures)
            if not runs:
                failures.append(f"managed_run_instance_missing:{instance_id}" if instance_id else "managed_run_runs_missing")
            counts = {
                "runs": len(runs),
                "plan_versions": _count_for_runs(connection, "managed_run_plan_versions", run_ids),
                "work_items": _count_for_runs(connection, "managed_run_work_items", run_ids),
                "linear_projections": _count_for_runs(connection, "managed_run_linear_projections", run_ids),
                "checkpoint_results": _count_for_runs(connection, "managed_run_checkpoint_results", run_ids),
                "attempts": len(attempts),
            }
    except (OSError, sqlite3.Error) as exc:
        failures.append(f"managed_run_db_unreadable:{type(exc).__name__}")
        return _db_audit_result(db_path, failures=failures)
    return _db_audit_result(
        db_path,
        failures=failures,
        integrity=integrity,
        counts=counts,
        runs=runs,
        attempts=attempts,
    )


def audit_runtime_evidence(data_root: Path, *, instance_id: str) -> dict[str, Any]:
    instance_root = data_root / "instances" / instance_id
    db_audit = audit_managed_run_db(managed_run_db_path(data_root), instance_id=instance_id)
    generations = generation_log_paths(instance_root)
    attempts = attempt_artifacts(instance_root)
    attempts_by_id = {entry.attempt_id: entry for entry in attempts}
    attempt_logs = [entry.log for entry in attempts if entry.log is not None]
    requests = [entry.request for entry in attempts if entry.request is not None]
    results = [entry.result for entry in attempts if entry.result is not None]
    failures = list(db_audit["failures"])
    durable_attempts = {
        str(attempt["attempt_id"]): attempt
        for attempt in db_audit["attempts"]
        if isinstance(attempt, dict) and attempt.get("attempt_id")
    }
    expected_attempts = {
        attempt_id: attempt
        for attempt_id, attempt in durable_attempts.items()
        if attempt.get("kind") in {"plan", "work_item"}
    }
    expected_attempt_ids = set(expected_attempts)
    for attempt_id in sorted(expected_attempt_ids - attempts_by_id.keys()):
        failures.append(f"attempt_artifacts_missing:{attempt_id}")
    for attempt_id in sorted(attempts_by_id.keys() - durable_attempts.keys()):
        failures.append(f"attempt_not_durable:{attempt_id}")
    for attempt_id, expected in expected_attempts.items():
        artifacts = attempts_by_id.get(attempt_id)
        if artifacts is not None:
            failures.extend(attempt_artifact_failures(expected, artifacts))
    for generation in generations:
        if file_empty(generation):
            failures.append(f"generation_log_empty:{generation.name}")
    for paths, missing_code in (
        (generations, "generation_logs_missing"),
        (attempt_logs, "attempt_logs_missing"),
        (requests, "turn_requests_missing"),
        (results, "turn_results_missing"),
    ):
        if not paths:
            failures.append(missing_code)
    return {
        **db_audit,
        "pass": not failures,
        "failures": failures,
        "instance_id": instance_id,
        "counts": {
            **db_audit["counts"],
            "generation_logs": len(generations),
            "attempt_logs": len(attempt_logs),
            "turn_requests": len(requests),
            "turn_results": len(results),
        },
        "runtime_artifacts": {
            "generation_logs": [_file_row(path) for path in generations],
            "attempts": [
                {
                    "attempt_id": entry.attempt_id,
                    "request_present": entry.request is not None,
                    "result_present": entry.result is not None,
                    "log_present": entry.log is not None,
                }
                for entry in attempts
            ],
        },
    }


def attempt_artifact_failures(expected: dict[str, Any], artifacts: AttemptArtifacts) -> list[str]:
    attempt_id = artifacts.attempt_id
    failures: list[str] = []
    for path, missing, empty in (
        (artifacts.request, "turn_request_missing", "turn_request_empty"),
        (artifacts.result, "turn_result_missing", "turn_result_empty"),
        (artifacts.log, "attempt_log_missing", "attempt_log_empty"),
    ):
        if path is None:
            failures.append(f"{missing}:{attempt_id}")
        elif file_empty(path):
            failures.append(f"{empty}:{attempt_id}")
    if artifacts.request is None or artifacts.result is None or file_empty(artifacts.request) or file_empty(artifacts.result):
        return failures
    request = _read_json_object(artifacts.request, "turn_request", attempt_id, failures)
    result = _read_json_object(artifacts.result, "turn_result", attempt_id, failures)
    if request is None or result is None:
        return failures
    request_context = _validated_context(request, "turn_request", attempt_id, failures)
    result_context = _validated_context(result, "turn_result", attempt_id, failures)
    expected_context = ManagedRunTurnContext.from_dict(
        expected.get("turn_context") if isinstance(expected.get("turn_context"), dict) else {}
    )
    if request_context is not None:
        if request_context.turn_id != attempt_id:
            failures.append(f"turn_request_attempt_mismatch:{attempt_id}")
        if request_context.run_id != str(expected.get("run_id") or ""):
            failures.append(f"turn_request_run_mismatch:{attempt_id}")
        expected_errors = expected_context.validation_errors()
        if expected_errors:
            failures.append(f"durable_turn_context_invalid:{attempt_id}:{expected_errors[0]}")
        else:
            mismatch = expected_context.mismatch_reason(request_context)
            if mismatch:
                failures.append(f"turn_request_context_mismatch:{attempt_id}:{mismatch}")
    if request_context is not None and result_context is not None:
        mismatch = request_context.mismatch_reason(result_context)
        if mismatch:
            failures.append(f"turn_result_context_mismatch:{attempt_id}:{mismatch}")
    request_kind = str(request.get("turn_kind") or "")
    result_kind = str(result.get("turn_kind") or "")
    if request_kind not in {"plan", "work_item"}:
        failures.append(f"turn_request_kind_invalid:{attempt_id}")
    if result_kind != request_kind:
        failures.append(f"turn_result_kind_mismatch:{attempt_id}")
    if artifacts.log is not None and not file_empty(artifacts.log):
        log_text = artifacts.log.read_text(encoding="utf-8", errors="replace")
        if f"attempt_id={attempt_id}" not in log_text:
            failures.append(f"attempt_log_correlation_missing:{attempt_id}:attempt_id")
        lease_id = request_context.lease_id if request_context is not None else expected_context.lease_id
        if lease_id and f"lease_id={lease_id}" not in log_text:
            failures.append(f"attempt_log_correlation_missing:{attempt_id}:lease_id")
    return failures


def file_empty(path: Path) -> bool:
    try:
        return path.stat().st_size <= 0
    except OSError:
        return True


def _read_json_object(path: Path, kind: str, attempt_id: str, failures: list[str]) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        failures.append(f"{kind}_invalid_json:{attempt_id}")
        return None
    if not isinstance(payload, dict):
        failures.append(f"{kind}_not_object:{attempt_id}")
        return None
    return payload


def _validated_context(
    payload: dict[str, Any],
    kind: str,
    attempt_id: str,
    failures: list[str],
) -> ManagedRunTurnContext | None:
    context = ManagedRunTurnContext.from_dict(
        payload.get("context") if isinstance(payload.get("context"), dict) else {}
    )
    errors = context.validation_errors()
    if errors:
        failures.append(f"{kind}_context_invalid:{attempt_id}:{errors[0]}")
        return None
    return context


def _safe_run_rows(
    rows: list[sqlite3.Row],
    failures: list[str],
) -> tuple[list[dict[str, Any]], list[str], list[dict[str, Any]]]:
    runs: list[dict[str, Any]] = []
    run_ids: list[str] = []
    attempts: list[dict[str, Any]] = []
    for row in rows:
        run_id = str(row["run_id"])
        try:
            payload = json.loads(str(row["payload_json"]))
        except json.JSONDecodeError:
            payload = {}
            failures.append(f"managed_run_payload_invalid:{run_id}")
        if not isinstance(payload, dict):
            payload = {}
            failures.append(f"managed_run_payload_not_object:{run_id}")
        failures.extend(
            f"managed_run_attempt_integrity:{run_id}:{error}"
            for error in attempt_integrity_errors(payload)
        )
        for attempt in canonical_attempt_records(payload):
            if not attempt.get("attempt_id"):
                continue
            failures.extend(
                f"managed_run_verify_attempt_invalid:{run_id}:{error}"
                for error in _verify_attempt_errors(attempt)
            )
            attempts.append(_evidence_attempt_row(run_id, attempt))
        state = str(row["state"])
        latest_reason = sanitize_text(str(row["latest_reason"]))
        if state in {"blocked", "failed"} and not latest_reason:
            failures.append(f"managed_run_failure_reason_missing:{run_id}")
        run_ids.append(run_id)
        runs.append(
            {
                "run_id": run_id,
                "issue_identifier": str(row["issue_identifier"]),
                "instance_id": str(row["instance_id"]),
                "state": state,
                "plan_version": int(row["plan_version"]),
                "latest_reason": latest_reason,
            }
        )
    return runs, run_ids, attempts


def _evidence_attempt_row(run_id: str, attempt: dict[str, Any]) -> dict[str, Any]:
    context = attempt.get("turn_context") if isinstance(attempt.get("turn_context"), dict) else {}
    return {
        "attempt_id": str(attempt.get("attempt_id") or ""),
        "run_id": run_id,
        "kind": str(attempt.get("kind") or ""),
        "state": str(attempt.get("state") or ""),
        "turn_context": sanitize_evidence_value(context),
        "gate_snapshot_hash": str(attempt.get("gate_snapshot_hash") or ""),
        "verification_evidence_present": isinstance(attempt.get("verification_evidence"), dict),
    }


def _verify_attempt_errors(attempt: dict[str, Any]) -> list[str]:
    if str(attempt.get("kind") or "") != "verify":
        return []
    errors: list[str] = []
    state = str(attempt.get("state") or "")
    gate_hash = attempt.get("gate_snapshot_hash")
    evidence = attempt.get("verification_evidence")
    if not isinstance(gate_hash, str) or (state == "succeeded" and not gate_hash):
        errors.append(f"gate_snapshot_hash_missing:{attempt.get('attempt_id') or 'missing'}")
    if not isinstance(evidence, dict) or (state == "succeeded" and not evidence):
        errors.append(f"verification_evidence_missing:{attempt.get('attempt_id') or 'missing'}")
    if state != "succeeded" and not str(attempt.get("sanitized_error") or ""):
        errors.append(f"failure_reason_missing:{attempt.get('attempt_id') or 'missing'}")
    return errors


def _count_for_runs(connection: sqlite3.Connection, table: str, run_ids: list[str]) -> int:
    if not run_ids:
        return 0
    placeholders = ",".join("?" for _ in run_ids)
    row = connection.execute(f"SELECT COUNT(*) FROM {table} WHERE run_id IN ({placeholders})", run_ids).fetchone()
    return int(row[0]) if row is not None else 0


def _db_audit_result(
    db_path: Path,
    *,
    failures: list[str],
    integrity: str | None = None,
    counts: dict[str, int] | None = None,
    runs: list[dict[str, Any]] | None = None,
    attempts: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    attempt_rows = attempts or []
    return {
        "pass": not failures,
        "managed_run_db": str(db_path),
        "integrity": integrity,
        "counts": counts or {name: 0 for name in ("runs", "plan_versions", "work_items", "linear_projections", "checkpoint_results", "attempts")},
        "runs": runs or [],
        "attempt_ids": [str(attempt["attempt_id"]) for attempt in attempt_rows],
        "attempts": attempt_rows,
        "failures": failures,
    }


def _file_row(path: Path) -> dict[str, Any]:
    try:
        size = path.stat().st_size
    except OSError:
        size = None
    return {"name": path.name, "size_bytes": size}


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Audit authoritative Managed Run state and runtime artifacts.")
    arg_parser.add_argument("--data-root", type=Path, required=True, help="Conductor data root containing managed_run/ and instances/.")
    arg_parser.add_argument("--instance-id", required=True, help="Conductor instance id to audit.")
    arg_parser.add_argument("--out", type=Path, help="Write JSON evidence to this path.")
    return arg_parser


def main() -> None:
    args = parser().parse_args()
    result = audit_runtime_evidence(args.data_root, instance_id=args.instance_id)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps(result, indent=2, sort_keys=True))
    if not result["pass"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
