from __future__ import annotations

import argparse
from contextlib import closing
import json
import sqlite3
from pathlib import Path
from typing import Any

from performer_api.turns import TurnContext
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


REQUIRED_TABLES = ("runs", "plan_revisions", "tasks", "attempts", "gate_evidence", "artifacts")


def audit_managed_run_db(db_path: Path, *, instance_id: str | None = None) -> dict[str, Any]:
    failures: list[str] = []
    if not db_path.is_file():
        return _db_result(db_path, ["workflow_db_missing"])
    try:
        with closing(sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)) as connection:
            connection.row_factory = sqlite3.Row
            integrity = str(connection.execute("PRAGMA quick_check").fetchone()[0])
            tables = {str(row[0]) for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            missing = [name for name in REQUIRED_TABLES if name not in tables]
            failures.extend(f"workflow_table_missing:{name}" for name in missing)
            if integrity != "ok":
                failures.append("workflow_db_integrity_failed")
            runs: list[dict[str, Any]] = []
            attempts: list[dict[str, Any]] = []
            if not missing:
                query = "SELECT run_id, issue_identifier, instance_id, state, plan_version, latest_reason FROM runs"
                parameters: tuple[str, ...] = ()
                if instance_id:
                    query += " WHERE instance_id = ?"
                    parameters = (instance_id,)
                rows = connection.execute(query + " ORDER BY created_at, run_id", parameters).fetchall()
                for row in rows:
                    reason = sanitize_text(str(row["latest_reason"] or ""))
                    if str(row["state"]) in {"blocked", "failed"} and not reason:
                        failures.append(f"workflow_failure_reason_missing:{row['run_id']}")
                    runs.append(
                        {
                            "run_id": str(row["run_id"]),
                            "issue_identifier": str(row["issue_identifier"]),
                            "instance_id": str(row["instance_id"]),
                            "state": str(row["state"]),
                            "plan_version": int(row["plan_version"] or 0),
                            "latest_reason": reason,
                        }
                    )
                run_ids = [run["run_id"] for run in runs]
                if not runs:
                    failures.append(f"workflow_runs_missing:{instance_id}" if instance_id else "workflow_runs_empty")
                attempts = _attempt_rows(connection, run_ids)
            counts = {
                "runs": len(runs),
                "plan_revisions": _count_for_runs(connection, "plan_revisions", [run["run_id"] for run in runs]) if not missing else 0,
                "tasks": _count_for_runs(connection, "tasks", [run["run_id"] for run in runs]) if not missing else 0,
                "gate_evidence": _count_for_runs(connection, "gate_evidence", [run["run_id"] for run in runs]) if not missing else 0,
                "artifacts": _count_for_runs(connection, "artifacts", [run["run_id"] for run in runs]) if not missing else 0,
                "attempts": len(attempts),
            }
    except (OSError, sqlite3.Error) as exc:
        failures.append(f"workflow_db_unreadable:{type(exc).__name__}")
        return _db_result(db_path, failures)
    return _db_result(db_path, failures, integrity=integrity, counts=counts, runs=runs, attempts=attempts)


def audit_runtime_evidence(data_root: Path, *, instance_id: str) -> dict[str, Any]:
    instance_root = data_root / "instances" / instance_id
    db_audit = audit_managed_run_db(managed_run_db_path(data_root), instance_id=instance_id)
    attempts = attempt_artifacts(instance_root)
    by_id = {entry.attempt_id: entry for entry in attempts}
    failures = list(db_audit["failures"])
    durable = {str(row["attempt_id"]): row for row in db_audit["attempts"] if row.get("attempt_id")}
    for attempt_id in sorted(set(durable) - set(by_id)):
        failures.append(f"attempt_artifacts_missing:{attempt_id}")
    for attempt_id, entry in by_id.items():
        if attempt_id not in durable:
            failures.append(f"attempt_not_durable:{attempt_id}")
        failures.extend(attempt_artifact_failures(entry))
    logs = generation_log_paths(instance_root)
    if not logs and not any(entry.log for entry in attempts):
        failures.append("performer_logs_missing")
    return {
        **db_audit,
        "pass": not failures,
        "failures": failures,
        "instance_id": instance_id,
        "counts": {
            **db_audit["counts"],
            "logs": len(logs),
            "attempt_artifacts": len(attempts),
        },
        "runtime_artifacts": {
            "logs": [_file_row(path) for path in logs],
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


def attempt_artifact_failures(entry: AttemptArtifacts) -> list[str]:
    failures: list[str] = []
    for path, missing, empty in (
        (entry.request, "turn_request_missing", "turn_request_empty"),
        (entry.result, "turn_result_missing", "turn_result_empty"),
        (entry.log, "attempt_log_missing", "attempt_log_empty"),
    ):
        if path is None:
            failures.append(f"{missing}:{entry.attempt_id}")
        elif file_empty(path):
            failures.append(f"{empty}:{entry.attempt_id}")
    if entry.request is None or entry.result is None or file_empty(entry.request) or file_empty(entry.result):
        return failures
    request = _read_json(entry.request)
    result = _read_json(entry.result)
    if request is None or result is None:
        failures.append(f"turn_json_invalid:{entry.attempt_id}")
        return failures
    request_context = _context(request, entry.attempt_id, failures, "turn_request")
    result_context = _context(result, entry.attempt_id, failures, "turn_result")
    if request_context and result_context:
        mismatch = request_context.mismatch_reason(result_context)
        if mismatch:
            failures.append(f"turn_context_mismatch:{entry.attempt_id}:{mismatch}")
    if str(request.get("turn_kind") or "") not in {"plan", "execute", "gate"}:
        failures.append(f"turn_request_kind_invalid:{entry.attempt_id}")
    if str(result.get("turn_kind") or "") != str(request.get("turn_kind") or ""):
        failures.append(f"turn_result_kind_mismatch:{entry.attempt_id}")
    return failures


def file_empty(path: Path) -> bool:
    try:
        return path.stat().st_size <= 0
    except OSError:
        return True


def _attempt_rows(connection: sqlite3.Connection, run_ids: list[str]) -> list[dict[str, Any]]:
    if not run_ids:
        return []
    placeholders = ",".join("?" for _ in run_ids)
    rows = connection.execute(
        f"SELECT attempt_id, run_id, task_id, kind, state, fencing_token, result_json FROM attempts WHERE run_id IN ({placeholders})",
        run_ids,
    ).fetchall()
    result: list[dict[str, Any]] = []
    for row in rows:
        try:
            payload = json.loads(str(row["result_json"]))
        except json.JSONDecodeError:
            payload = {}
        result.append(
            {
                "attempt_id": str(row["attempt_id"]),
                "run_id": str(row["run_id"]),
                "task_id": str(row["task_id"]),
                "kind": str(row["kind"]),
                "state": str(row["state"]),
                "fencing_token": int(row["fencing_token"] or 0),
                "result": sanitize_evidence_value(payload),
            }
        )
    return result


def _count_for_runs(connection: sqlite3.Connection, table: str, run_ids: list[str]) -> int:
    if not run_ids:
        return 0
    placeholders = ",".join("?" for _ in run_ids)
    row = connection.execute(f"SELECT COUNT(*) FROM {table} WHERE run_id IN ({placeholders})", run_ids).fetchone()
    return int(row[0]) if row else 0


def _context(payload: dict[str, Any], attempt_id: str, failures: list[str], kind: str) -> TurnContext | None:
    context = TurnContext.from_dict(payload.get("context") if isinstance(payload.get("context"), dict) else {})
    errors = context.validation_errors()
    if errors:
        failures.append(f"{kind}_context_invalid:{attempt_id}:{errors[0]}")
        return None
    if context.attempt_id != attempt_id:
        failures.append(f"{kind}_attempt_mismatch:{attempt_id}")
    return context


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _file_row(path: Path) -> dict[str, Any]:
    try:
        size = path.stat().st_size
    except OSError:
        size = None
    return {"name": path.name, "size_bytes": size}


def _db_result(
    db_path: Path,
    failures: list[str],
    *,
    integrity: str | None = None,
    counts: dict[str, int] | None = None,
    runs: list[dict[str, Any]] | None = None,
    attempts: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "pass": not failures,
        "workflow_db": str(db_path),
        "integrity": integrity,
        "counts": counts or {"runs": 0, "plan_revisions": 0, "tasks": 0, "gate_evidence": 0, "artifacts": 0, "attempts": 0},
        "runs": runs or [],
        "attempt_ids": [str(item["attempt_id"]) for item in attempts or []],
        "attempts": attempts or [],
        "failures": failures,
    }


def parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Audit compact workflow state and runtime artifacts.")
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--out", type=Path)
    return parser


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
