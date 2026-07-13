from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any
from uuid import uuid4

from performer_api.performer_control import PerformerControlError, PerformerReadinessState
from performer_api.workflow import Plan

from .acceptance_evidence import (
    artifact_metadata,
    canonical_gate_evidence,
    gate_evidence_projection,
    gate_number,
)
from .conductor_smoke_protocol import sanitize_reason
from .models import (
    AttemptState,
    ConductorSettings,
    InstanceRecord,
    RunState,
    StaleAttemptError,
    TaskState,
    utc_now_iso,
)


def _dump(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _load(value: str) -> dict[str, Any]:
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return decoded if isinstance(decoded, dict) else {}


def _load_list(value: str) -> list[Any]:
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        return []
    return decoded if isinstance(decoded, list) else []


INSTANCE_COLUMNS = (
    "id", "name", "repo_source_type", "repo_source_value", "resolved_repo_path",
    "instance_dir", "workspace_root", "persistence_path", "log_path", "http_port",
    "linear_project", "linear_filters_json", "process_status", "pid", "last_exit_code",
    "last_error", "restart_count", "restart_window_started_at", "restart_next_at",
    "created_at", "updated_at",
)


def _settings_values(settings: ConductorSettings) -> tuple[Any, ...]:
    return (
        settings.podium_url,
        settings.podium_runtime_id,
        settings.podium_runtime_token,
        settings.podium_proxy_token,
        1 if settings.managed_mode else 0,
        settings.conductor_id,
        utc_now_iso(),
    )


def _instance_values(instance: InstanceRecord) -> tuple[Any, ...]:
    return (
        instance.id, instance.name, instance.repo_source_type, instance.repo_source_value,
        instance.resolved_repo_path, instance.instance_dir, instance.workspace_root,
        instance.persistence_path, instance.log_path, instance.http_port, instance.linear_project,
        json.dumps(instance.linear_filters, separators=(",", ":"), sort_keys=True),
        instance.process_status, instance.pid, instance.last_exit_code, instance.last_error,
        instance.restart_count, instance.restart_window_started_at, instance.restart_next_at,
        instance.created_at, instance.updated_at,
    )


def _instance_from_row(row: sqlite3.Row) -> InstanceRecord:
    filters = json.loads(str(row["linear_filters_json"])) if row["linear_filters_json"] else {}
    return InstanceRecord(
        id=str(row["id"]), name=str(row["name"]), repo_source_type=row["repo_source_type"],
        repo_source_value=str(row["repo_source_value"]), resolved_repo_path=str(row["resolved_repo_path"]),
        instance_dir=str(row["instance_dir"]), workspace_root=str(row["workspace_root"]),
        persistence_path=str(row["persistence_path"]), log_path=str(row["log_path"]),
        http_port=int(row["http_port"]), linear_project=str(row["linear_project"]),
        linear_filters=filters if isinstance(filters, dict) else {}, process_status=row["process_status"],
        pid=row["pid"], last_exit_code=row["last_exit_code"], last_error=row["last_error"],
        restart_count=int(row["restart_count"] or 0), restart_window_started_at=row["restart_window_started_at"],
        restart_next_at=row["restart_next_at"], created_at=str(row["created_at"]), updated_at=str(row["updated_at"]),
    )


class ConductorStore:
    def __init__(self, data_root: Path) -> None:
        self.data_root = Path(data_root)
        self.instances_root = self.data_root / "instances"
        self.db_path = self.data_root / "workflow.db"
        self.data_root.mkdir(parents=True, exist_ok=True)
        self.instances_root.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def list_instances(self) -> list[InstanceRecord]:
        with self.connect() as connection:
            rows = connection.execute(
                f"SELECT {', '.join(INSTANCE_COLUMNS)} FROM instances ORDER BY created_at, id"
            ).fetchall()
        return [_instance_from_row(row) for row in rows]

    def get_instance(self, instance_id: str) -> InstanceRecord | None:
        with self.connect() as connection:
            row = connection.execute(
                f"SELECT {', '.join(INSTANCE_COLUMNS)} FROM instances WHERE id = ?",
                (instance_id,),
            ).fetchone()
        return _instance_from_row(row) if row is not None else None

    def get_settings(self) -> ConductorSettings:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT
                  podium_url,
                  podium_runtime_id,
                  podium_runtime_token,
                  podium_proxy_token,
                  managed_mode,
                  conductor_id
                FROM settings
                WHERE id = 1
                """
            ).fetchone()
            if row is None:
                settings = ConductorSettings()
                connection.execute(
                    """
                    INSERT INTO settings (
                      id,
                      podium_url,
                      podium_runtime_id,
                      podium_runtime_token,
                      podium_proxy_token,
                      managed_mode,
                      conductor_id,
                      updated_at
                    )
                    VALUES (1, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    _settings_values(settings),
                )
                return settings
        return ConductorSettings.from_dict(dict(row))

    def save_settings(self, settings: ConductorSettings) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO settings (
                  id,
                  podium_url,
                  podium_runtime_id,
                  podium_runtime_token,
                  podium_proxy_token,
                  managed_mode,
                  conductor_id,
                  updated_at
                )
                VALUES (1, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  podium_url = excluded.podium_url,
                  podium_runtime_id = excluded.podium_runtime_id,
                  podium_runtime_token = excluded.podium_runtime_token,
                  podium_proxy_token = excluded.podium_proxy_token,
                  managed_mode = excluded.managed_mode,
                  conductor_id = excluded.conductor_id,
                  updated_at = excluded.updated_at
                """,
                _settings_values(settings),
            )

    def create_instance(self, instance: InstanceRecord) -> None:
        with self.connect() as connection:
            try:
                connection.execute(
                    f"""
                    INSERT INTO instances ({', '.join(INSTANCE_COLUMNS)})
                    VALUES ({', '.join('?' for _ in INSTANCE_COLUMNS)})
                    """,
                    _instance_values(instance),
                )
            except sqlite3.IntegrityError as exc:
                raise FileExistsError(f"Metadata already exists for {instance.id}") from exc

    def update_instance(self, instance: InstanceRecord) -> None:
        with self.connect() as connection:
            self._update_instance(connection, instance)

    def replace_instance_and_clear_managed_runs(self, instance: InstanceRecord) -> None:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._update_instance(connection, instance)
            self._clear_managed_runs(connection)

    @staticmethod
    def _update_instance(connection: sqlite3.Connection, instance: InstanceRecord) -> None:
        assignments = ", ".join(f"{column} = ?" for column in INSTANCE_COLUMNS if column != "id")
        values = [
            value
            for column, value in zip(INSTANCE_COLUMNS, _instance_values(instance), strict=True)
            if column != "id"
        ]
        cursor = connection.execute(
            f"UPDATE instances SET {assignments} WHERE id = ?",
            (*values, instance.id),
        )
        if cursor.rowcount == 0:
            raise FileNotFoundError(f"Metadata does not exist for {instance.id}")

    def delete_instance(self, instance_id: str) -> None:
        with self.connect() as connection:
            connection.execute("DELETE FROM instances WHERE id = ?", (instance_id,))

    def allocate_port(self, *, start: int = 8801) -> int:
        with self.connect() as connection:
            rows = connection.execute("SELECT http_port FROM instances").fetchall()
        used = {int(row["http_port"]) for row in rows}
        port = start
        while port in used:
            port += 1
        return port

    def get_performer_control_state(self) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM performer_control_state WHERE id = 1"
            ).fetchone()
        if row is None:
            return self.reset_performer_control_state()
        return _performer_control_state(row)

    def reset_performer_control_state(self) -> dict[str, Any]:
        now = utc_now_iso()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                INSERT INTO performer_control_state (
                  id,
                  performer_kind,
                  binding_generation,
                  capability_version,
                  execution_policy_sha256,
                  status,
                  last_check_status,
                  last_check_started_at,
                  last_check_finished_at,
                  error_code,
                  sanitized_reason,
                  action_required,
                  retryable,
                  attempt_number,
                  next_action,
                  updated_at
                ) VALUES (1, '', 0, 0, '', 'unchecked', 'none', NULL, NULL, '', '', 0, 0, NULL, '', ?)
                ON CONFLICT(id) DO UPDATE SET
                  status = 'unchecked',
                  updated_at = excluded.updated_at
                """,
                (now,),
            )
            row = connection.execute(
                "SELECT * FROM performer_control_state WHERE id = 1"
            ).fetchone()
        if row is None:
            raise RuntimeError("performer_control_state_missing")
        return _performer_control_state(row)

    def ensure_performer_control_identity(
        self,
        *,
        performer_kind: str,
        binding_generation: int,
        capability_version: int,
        execution_policy_sha256: str,
    ) -> dict[str, Any]:
        identity = PerformerReadinessState(
            performer_kind=performer_kind,
            binding_generation=binding_generation,
            capability_version=capability_version,
            execution_policy_sha256=execution_policy_sha256,
            status="unchecked",
            last_check_status="none",
            error=None,
        )
        current = self.get_performer_control_state()
        if all(
            current[key] == value
            for key, value in (
                ("performer_kind", identity.performer_kind),
                ("binding_generation", identity.binding_generation),
                ("capability_version", identity.capability_version),
                ("execution_policy_sha256", identity.execution_policy_sha256),
            )
        ):
            return current
        now = utc_now_iso()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                UPDATE performer_control_state
                SET performer_kind = ?,
                    binding_generation = ?,
                    capability_version = ?,
                    execution_policy_sha256 = ?,
                    status = 'unchecked',
                    last_check_status = 'none',
                    last_check_started_at = NULL,
                    last_check_finished_at = NULL,
                    error_code = '',
                    sanitized_reason = '',
                    action_required = 0,
                    retryable = 0,
                    attempt_number = NULL,
                    next_action = '',
                    updated_at = ?
                WHERE id = 1
                """,
                (
                    identity.performer_kind,
                    identity.binding_generation,
                    identity.capability_version,
                    identity.execution_policy_sha256,
                    now,
                ),
            )
            row = connection.execute(
                "SELECT * FROM performer_control_state WHERE id = 1"
            ).fetchone()
        if row is None:
            raise RuntimeError("performer_control_state_missing")
        return _performer_control_state(row)

    def record_performer_readiness(
        self,
        readiness: PerformerReadinessState,
        *,
        check_started_at: str | None = None,
        check_finished_at: str | None = None,
    ) -> dict[str, Any]:
        if not isinstance(readiness, PerformerReadinessState):
            raise TypeError("readiness must be PerformerReadinessState")
        error = readiness.error
        now = utc_now_iso()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                UPDATE performer_control_state
                SET performer_kind = ?,
                    binding_generation = ?,
                    capability_version = ?,
                    execution_policy_sha256 = ?,
                    status = ?,
                    last_check_status = ?,
                    last_check_started_at = COALESCE(?, last_check_started_at),
                    last_check_finished_at = COALESCE(?, last_check_finished_at),
                    error_code = ?,
                    sanitized_reason = ?,
                    action_required = ?,
                    retryable = ?,
                    attempt_number = ?,
                    next_action = ?,
                    updated_at = ?
                WHERE id = 1
                """,
                (
                    readiness.performer_kind,
                    readiness.binding_generation,
                    readiness.capability_version,
                    readiness.execution_policy_sha256,
                    readiness.status,
                    readiness.last_check_status,
                    check_started_at,
                    check_finished_at,
                    error.error_code if error is not None else "",
                    error.sanitized_reason if error is not None else "",
                    int(error.action_required) if error is not None else 0,
                    int(error.retryable) if error is not None else 0,
                    error.attempt_number if error is not None else None,
                    error.next_action if error is not None else "",
                    now,
                ),
            )
            row = connection.execute(
                "SELECT * FROM performer_control_state WHERE id = 1"
            ).fetchone()
        if row is None:
            raise RuntimeError("performer_control_state_missing")
        return _performer_control_state(row)

    def block_run_for_performer(
        self,
        run_id: str,
        *,
        performer_kind: str,
        binding_generation: int,
        execution_policy_sha256: str,
        error: PerformerControlError,
        task_id: str | None = None,
    ) -> dict[str, Any]:
        if not isinstance(error, PerformerControlError):
            raise TypeError("error must be PerformerControlError")
        run = self.get_run(run_id)
        if run is None:
            raise KeyError(run_id)
        payload = dict(run.get("payload") or {})
        existing = payload.get("performer_readiness_block")
        prior_phase = (
            str(existing.get("prior_phase") or "")
            if isinstance(existing, dict)
            else _performer_prior_phase(run, self.get_task(run_id, task_id) if task_id else None)
        )
        marker = {
            "version": 1,
            "performer_kind": performer_kind,
            "binding_generation": binding_generation,
            "execution_policy_sha256": execution_policy_sha256,
            **error.to_dict(),
            "prior_phase": prior_phase,
            "linear_projection": {
                "status": "pending",
                "attempt_number": 0,
                "last_error_code": None,
                "last_sanitized_reason": None,
                "next_action": "project_linear_readiness_block",
            },
        }
        if task_id:
            marker["task_id"] = task_id
        payload["performer_readiness_block"] = marker
        now = utc_now_iso()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if task_id:
                task_row = connection.execute(
                    "SELECT * FROM tasks WHERE run_id = ? AND task_id = ?",
                    (run_id, task_id),
                ).fetchone()
                if task_row is None:
                    raise KeyError(task_id)
                task_result = _load(task_row["result_json"])
                task_marker = dict(marker)
                task_marker.pop("linear_projection", None)
                task_marker["prior_state"] = str(task_row["state"])
                task_result["performer_readiness_block"] = task_marker
                connection.execute(
                    "UPDATE tasks SET state = ?, result_json = ?, updated_at = ? WHERE run_id = ? AND task_id = ?",
                    (
                        TaskState.BLOCKED.value,
                        _dump(task_result),
                        now,
                        run_id,
                        task_id,
                    ),
                )
            connection.execute(
                "UPDATE runs SET state = ?, active_task_id = ?, latest_reason = ?, payload_json = ?, updated_at = ? WHERE run_id = ?",
                (
                    RunState.BLOCKED.value,
                    task_id or str(run.get("active_task_id") or ""),
                    error.error_code,
                    _dump(payload),
                    now,
                    run_id,
                ),
            )
        blocked = self.get_run(run_id)
        if blocked is None:
            raise RuntimeError("performer_readiness_block_missing")
        return blocked

    def record_performer_readiness_projection(
        self,
        run_id: str,
        *,
        status: str,
        error_code: str | None = None,
        sanitized_reason: str | None = None,
        next_action: str,
    ) -> dict[str, Any]:
        if status not in {"pending", "complete"}:
            raise ValueError("performer readiness projection status is invalid")
        run = self.get_run(run_id)
        if run is None:
            raise KeyError(run_id)
        payload = dict(run.get("payload") or {})
        marker = payload.get("performer_readiness_block")
        if not isinstance(marker, dict):
            raise RuntimeError("performer_readiness_block_missing")
        projection = marker.get("linear_projection")
        attempt_number = (
            int(projection.get("attempt_number") or 0)
            if isinstance(projection, dict)
            else 0
        )
        marker = dict(marker)
        marker["linear_projection"] = {
            "status": status,
            "attempt_number": attempt_number + 1,
            "last_error_code": error_code,
            "last_sanitized_reason": sanitized_reason,
            "next_action": next_action,
        }
        payload["performer_readiness_block"] = marker
        with self.connect() as connection:
            connection.execute(
                "UPDATE runs SET payload_json = ?, updated_at = ? WHERE run_id = ?",
                (_dump(payload), utc_now_iso(), run_id),
            )
        updated = self.get_run(run_id)
        if updated is None:
            raise RuntimeError("performer_readiness_projection_missing")
        return updated

    def resume_run_from_performer_block(
        self,
        run_id: str,
        *,
        performer_kind: str,
        binding_generation: int,
        execution_policy_sha256: str,
    ) -> dict[str, Any]:
        run = self.get_run(run_id)
        if run is None:
            raise KeyError(run_id)
        payload = dict(run.get("payload") or {})
        marker = payload.get("performer_readiness_block")
        if not isinstance(marker, dict):
            return run
        if (
            marker.get("performer_kind") != performer_kind
            or marker.get("binding_generation") != binding_generation
            or marker.get("execution_policy_sha256") != execution_policy_sha256
        ):
            return run
        projection = marker.get("linear_projection")
        if not isinstance(projection, dict) or projection.get("status") != "complete":
            return run
        prior_phase = str(marker.get("prior_phase") or "planning")
        resumed_state = (
            RunState.PLANNING.value
            if prior_phase == RunState.PLANNING.value
            else RunState.EXECUTING.value
        )
        payload.pop("performer_readiness_block", None)
        now = utc_now_iso()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            task_id = str(marker.get("task_id") or run.get("active_task_id") or "")
            if task_id:
                task_row = connection.execute(
                    "SELECT * FROM tasks WHERE run_id = ? AND task_id = ?",
                    (run_id, task_id),
                ).fetchone()
                if task_row is not None:
                    task_result = _load(task_row["result_json"])
                    task_marker = task_result.pop("performer_readiness_block", None)
                    prior_state = (
                        str(task_marker.get("prior_state") or TaskState.IN_PROGRESS.value)
                        if isinstance(task_marker, dict)
                        else TaskState.IN_PROGRESS.value
                    )
                    connection.execute(
                        "UPDATE tasks SET state = ?, result_json = ?, updated_at = ? WHERE run_id = ? AND task_id = ?",
                        (prior_state, _dump(task_result), now, run_id, task_id),
                    )
            connection.execute(
                "UPDATE runs SET state = ?, latest_reason = 'performer_readiness_resumed', payload_json = ?, updated_at = ? WHERE run_id = ?",
                (resumed_state, _dump(payload), now, run_id),
            )
        resumed = self.get_run(run_id)
        if resumed is None:
            raise RuntimeError("performer_readiness_resume_missing")
        return resumed

    def create_run(self, parent_issue_id: str, issue_identifier: str, *, instance_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            existing = connection.execute(
                "SELECT * FROM runs WHERE parent_issue_id = ?",
                (parent_issue_id,),
            ).fetchone()
            if existing is not None:
                return _run(existing)
            run_id = f"run-{uuid4().hex}"
            now = utc_now_iso()
            connection.execute(
                """
                INSERT INTO runs (
                  run_id, parent_issue_id, issue_identifier, instance_id, state,
                  active_task_id, plan_version, policy_revision, latest_reason,
                  payload_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, '', 0, 0, '', '{}', ?, ?)
                """,
                (run_id, parent_issue_id, issue_identifier, instance_id, RunState.PLANNING.value, now, now),
            )
        return self.get_run(run_id) or {}

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        return _run(row) if row is not None else None

    def list_runs(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM runs ORDER BY created_at, run_id").fetchall()
        return [_run(row) for row in rows]

    @staticmethod
    def _clear_managed_runs(connection: sqlite3.Connection) -> None:
        for table in (
            "artifacts",
            "gate_evidence",
            "acceptance_catalog",
            "runtime_waits",
            "attempts",
            "tasks",
            "plan_revisions",
            "runs",
        ):
            connection.execute(f"DELETE FROM {table}")

    def update_run_payload(self, run_id: str, updates: dict[str, Any]) -> None:
        current = self.get_run(run_id) or {}
        payload = dict(current.get("payload") or {})
        payload.update(updates)
        with self.connect() as connection:
            connection.execute(
                "UPDATE runs SET payload_json = ?, updated_at = ? WHERE run_id = ?",
                (_dump(payload), utc_now_iso(), run_id),
            )

    def fail_run(self, run_id: str, reason: str) -> None:
        with self.connect() as connection:
            connection.execute(
                "UPDATE runs SET state = ?, latest_reason = ?, updated_at = ? WHERE run_id = ?",
                (RunState.FAILED.value, sanitize_reason(reason), utc_now_iso(), run_id),
            )

    def update_run_reason(self, run_id: str, reason: str) -> None:
        with self.connect() as connection:
            connection.execute(
                "UPDATE runs SET latest_reason = ?, updated_at = ? WHERE run_id = ?",
                (sanitize_reason(reason), utc_now_iso(), run_id),
            )

    def managed_run_view(self) -> dict[str, Any]:
        runs: list[dict[str, Any]] = []
        for run in self.list_runs():
            run_id = str(run["run_id"])
            tasks = self.list_tasks(run_id)
            for task in tasks:
                summary = self.get_gate_evidence_summary(run_id, str(task["task_id"]))
                if summary is not None:
                    task["gate"] = summary
            runs.append(
                {
                    **run,
                    "tasks": tasks,
                    "plan": self.get_plan(run_id),
                    "runtime_waits": self.list_runtime_waits(run_id),
                }
            )
        return {"runs": runs}

    def get_gate_evidence_summary(self, run_id: str, task_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            run = connection.execute(
                "SELECT plan_version FROM runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            row = connection.execute(
                """
                SELECT attempt_id, evidence_json
                FROM gate_evidence
                WHERE run_id = ? AND task_id = ?
                ORDER BY created_at DESC, rowid DESC
                LIMIT 1
                """,
                (run_id, task_id),
            ).fetchone()
        if run is None or row is None:
            return None
        current_plan_version = int(run["plan_version"] or 0)
        summary = gate_evidence_projection(
            _load(str(row["evidence_json"])),
            attempt_id=str(row["attempt_id"]),
        )
        return summary if summary is not None and summary["plan_version"] == current_plan_version else None

    def list_tasks(self, run_id: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM tasks WHERE run_id = ? ORDER BY position, task_id",
                (run_id,),
            ).fetchall()
        return [_task(row) for row in rows]

    def get_task(self, run_id: str, task_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM tasks WHERE run_id = ? AND task_id = ?",
                (run_id, task_id),
            ).fetchone()
        return _task(row) if row is not None else None

    def attach_task_issue(
        self,
        run_id: str,
        task_id: str,
        *,
        issue_id: str,
        identifier: str = "",
        state: str = "",
    ) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                UPDATE tasks
                SET linear_issue_id = ?, linear_identifier = ?, linear_state = ?, updated_at = ?
                WHERE run_id = ? AND task_id = ?
                """,
                (issue_id, identifier, state, utc_now_iso(), run_id, task_id),
            )

    def update_task_linear_state(self, run_id: str, task_id: str, state: str) -> None:
        with self.connect() as connection:
            connection.execute(
                "UPDATE tasks SET linear_state = ?, updated_at = ? WHERE run_id = ? AND task_id = ?",
                (state, utc_now_iso(), run_id, task_id),
            )

    def save_plan(
        self,
        run_id: str,
        plan: Plan,
        *,
        policy_revision: int = 1,
        approval_required: bool | None = None,
        reason: str = "initial plan",
        manifest_refs: list[str] | None = None,
    ) -> int:
        approval_required = plan.approval_required if approval_required is None else approval_required
        now = utc_now_iso()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT COALESCE(MAX(version), 0) AS version FROM plan_revisions WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            version = int(row["version"] if row is not None else 0) + 1
            status = "awaiting_approval" if approval_required else "active"
            if status == "active":
                connection.execute(
                    "UPDATE plan_revisions SET status = 'superseded' WHERE run_id = ? AND status = 'active'",
                    (run_id,),
                )
            connection.execute(
                """
                INSERT INTO plan_revisions (
                  run_id, version, status, reason, approval_id, policy_revision,
                  plan_json, manifest_json, created_at
                ) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)
                """,
                (run_id, version, status, reason, policy_revision, _dump(plan.to_dict()), _dump(manifest_refs or []), now),
            )
            if plan.acceptance_catalog is not None:
                connection.execute(
                    "INSERT OR REPLACE INTO acceptance_catalog (run_id, version, catalog_json, updated_at) VALUES (?, ?, ?, ?)",
                    (run_id, version, _dump(plan.acceptance_catalog.to_dict()), now),
                )
            for position, task in enumerate(plan.tasks):
                connection.execute(
                    """
                    INSERT INTO tasks (
                    run_id, task_id, parent_issue_id, position, state, gate_status,
                      rework_count, linear_issue_id, linear_identifier, linear_state,
                      task_json, result_json, updated_at
                    ) VALUES (?, ?, (SELECT parent_issue_id FROM runs WHERE run_id = ?), ?, ?, '', 0, '', '', '', ?, '{}', ?)
                    ON CONFLICT(run_id, task_id) DO UPDATE SET
                      position = excluded.position,
                      task_json = excluded.task_json,
                      updated_at = excluded.updated_at
                    """,
                    (run_id, task.id, run_id, position, TaskState.TODO.value, _dump(task.to_dict()), now),
                )
            state = RunState.AWAITING_APPROVAL.value if approval_required else RunState.EXECUTING.value
            connection.execute(
                "UPDATE runs SET state = ?, plan_version = ?, policy_revision = ?, latest_reason = ?, updated_at = ? WHERE run_id = ?",
                (state, version, policy_revision, "plan_approval_required" if approval_required else "", now, run_id),
            )
        return version

    def get_plan(self, run_id: str, version: int | None = None) -> dict[str, Any] | None:
        with self.connect() as connection:
            if version is None:
                row = connection.execute(
                    "SELECT plan_json FROM plan_revisions WHERE run_id = ? ORDER BY version DESC LIMIT 1",
                    (run_id,),
                ).fetchone()
            else:
                row = connection.execute(
                    "SELECT plan_json FROM plan_revisions WHERE run_id = ? AND version = ?",
                    (run_id, version),
                ).fetchone()
        if row is None:
            return None
        try:
            payload = json.loads(row["plan_json"])
        except json.JSONDecodeError:
            return None
        return payload if isinstance(payload, dict) else None

    def approve_plan(self, run_id: str, version: int, *, approval_id: str) -> None:
        now = utc_now_iso()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            run = connection.execute(
                "SELECT state, plan_version FROM runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            revision = connection.execute(
                "SELECT status FROM plan_revisions WHERE run_id = ? AND version = ?",
                (run_id, version),
            ).fetchone()
            if revision is None:
                raise ValueError("plan revision not found")
            if (
                run is None
                or str(run["state"]) != RunState.AWAITING_APPROVAL.value
                or int(run["plan_version"] or 0) != version
                or str(revision["status"]) != "awaiting_approval"
            ):
                raise ValueError("plan revision is not awaiting approval")
            connection.execute(
                "UPDATE plan_revisions SET status = 'superseded' WHERE run_id = ? AND status = 'active'",
                (run_id,),
            )
            changed = connection.execute(
                "UPDATE plan_revisions SET status = 'active', approval_id = ? WHERE run_id = ? AND version = ? AND status = 'awaiting_approval'",
                (approval_id, run_id, version),
            ).rowcount
            if not changed:
                raise ValueError("plan revision is not awaiting approval")
            connection.execute(
                "UPDATE runs SET state = ?, latest_reason = '', updated_at = ? WHERE run_id = ?",
                (RunState.EXECUTING.value, now, run_id),
            )

    def next_task(self, run_id: str) -> dict[str, Any] | None:
        tasks = self.list_tasks(run_id)
        for task in tasks:
            if task["state"] == TaskState.DONE.value:
                continue
            if task["state"] == TaskState.TODO.value:
                return task
            if task["state"] == TaskState.IN_PROGRESS.value:
                with self.connect() as connection:
                    active = connection.execute(
                        "SELECT 1 FROM attempts WHERE run_id = ? AND task_id = ? AND state IN ('running', 'waiting') LIMIT 1",
                        (run_id, task["task_id"]),
                    ).fetchone()
                if active is None:
                    return task
            return None
        return None

    def start_plan(self, run_id: str) -> dict[str, Any]:
        now = utc_now_iso()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT * FROM attempts WHERE run_id = ? AND kind = 'plan' AND state IN ('running', 'waiting') ORDER BY created_at DESC LIMIT 1",
                (run_id,),
            ).fetchone()
            if existing is not None:
                return _attempt_dict(existing)
            previous = connection.execute(
                "SELECT COALESCE(MAX(fencing_token), 0) AS token FROM attempts WHERE run_id = ? AND kind = 'plan'",
                (run_id,),
            ).fetchone()
            token = int(previous["token"] if previous is not None else 0) + 1
            attempt_id = f"attempt-{uuid4().hex}"
            connection.execute(
                "INSERT INTO attempts (attempt_id, run_id, task_id, kind, state, fencing_token, result_json, created_at, updated_at) VALUES (?, ?, '', 'plan', ?, ?, '{}', ?, ?)",
                (attempt_id, run_id, AttemptState.RUNNING.value, token, now, now),
            )
            connection.execute(
                "UPDATE runs SET state = ?, updated_at = ? WHERE run_id = ?",
                (RunState.PLANNING.value, now, run_id),
            )
            row = connection.execute("SELECT * FROM attempts WHERE attempt_id = ?", (attempt_id,)).fetchone()
        return _attempt_dict(row) if row is not None else {}

    def record_plan(
        self,
        run_id: str,
        attempt_id: str,
        fencing_token: int,
        plan: Plan,
        *,
        policy_revision: int = 1,
        manifest_refs: list[str] | None = None,
    ) -> int:
        attempt = self._attempt(run_id, attempt_id, fencing_token, kind="plan")
        if self._result_attempt_is_duplicate(attempt):
            return int((self.get_run(run_id) or {}).get("plan_version") or 0)
        self._require_running_attempt(attempt)
        version = self.save_plan(
            run_id,
            plan,
            policy_revision=policy_revision,
            approval_required=plan.approval_required,
            manifest_refs=manifest_refs,
        )
        now = utc_now_iso()
        with self.connect() as connection:
            connection.execute(
                "UPDATE attempts SET state = ?, result_json = ?, updated_at = ? WHERE attempt_id = ?",
                (AttemptState.SUCCEEDED.value, _dump(plan.to_dict()), now, attempt["attempt_id"]),
            )
        return version

    def record_runtime_wait(self, run_id: str, attempt_id: str, fencing_token: int, *, kind: str, reason: str) -> None:
        attempt = self._attempt(run_id, attempt_id, fencing_token)
        if self._result_attempt_is_duplicate(attempt):
            return
        self._require_running_attempt(attempt)
        reason = sanitize_reason(reason)
        now = utc_now_iso()
        wait_id = f"wait-{uuid4().hex}"
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if self._guard_attempt_state(connection, attempt_id):
                return
            connection.execute(
                "INSERT INTO runtime_waits (wait_id, run_id, task_id, kind, reason, state, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)",
                (wait_id, run_id, attempt.get("task_id") or "", kind, reason, now),
            )
            connection.execute(
                "UPDATE attempts SET state = ?, result_json = ?, updated_at = ? WHERE attempt_id = ?",
                (AttemptState.WAITING.value, _dump({"kind": kind, "reason": reason}), now, attempt_id),
            )
            connection.execute(
                "UPDATE runs SET state = ?, latest_reason = ?, updated_at = ? WHERE run_id = ?",
                (RunState.BLOCKED.value, f"runtime_wait:{kind}", now, run_id),
            )

    def list_runtime_waits(self, run_id: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM runtime_waits WHERE run_id = ? ORDER BY created_at",
                (run_id,),
            ).fetchall()
        return [{key: row[key] for key in row.keys()} for row in rows]

    def attach_wait_issue(self, wait_id: str, *, issue_id: str, identifier: str = "") -> None:
        with self.connect() as connection:
            connection.execute(
                "UPDATE runtime_waits SET linear_issue_id = ?, linear_identifier = ? WHERE wait_id = ?",
                (issue_id, identifier, wait_id),
            )

    def resume_runtime_wait(self, run_id: str) -> bool:
        now = utc_now_iso()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            waits = connection.execute(
                "SELECT * FROM runtime_waits WHERE run_id = ? AND state = 'open' ORDER BY created_at",
                (run_id,),
            ).fetchall()
            if not waits:
                return False
            for wait in waits:
                connection.execute(
                    "UPDATE runtime_waits SET state = 'resolved' WHERE wait_id = ?",
                    (wait["wait_id"],),
                )
                connection.execute(
                    "UPDATE attempts SET state = ?, updated_at = ? WHERE run_id = ? AND task_id = ? AND state = 'waiting'",
                    (AttemptState.STALE.value, now, run_id, wait["task_id"]),
                )
                if wait["task_id"]:
                    connection.execute(
                        "UPDATE tasks SET state = ?, updated_at = ? WHERE run_id = ? AND task_id = ?",
                        (TaskState.IN_PROGRESS.value, now, run_id, wait["task_id"]),
                    )
            run = connection.execute("SELECT plan_version FROM runs WHERE run_id = ?", (run_id,)).fetchone()
            next_state = RunState.PLANNING.value if not run or int(run["plan_version"] or 0) == 0 else RunState.EXECUTING.value
            connection.execute(
                "UPDATE runs SET state = ?, latest_reason = 'runtime_wait_resumed', updated_at = ? WHERE run_id = ?",
                (next_state, now, run_id),
            )
        return True

    def start_task(self, run_id: str, task_id: str) -> dict[str, Any]:
        now = utc_now_iso()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM tasks WHERE run_id = ? AND task_id = ?",
                (run_id, task_id),
            ).fetchone()
            if row is None or row["state"] not in {TaskState.TODO.value, TaskState.IN_PROGRESS.value}:
                raise ValueError(f"task is not ready: {task_id}")
            previous = connection.execute(
                "SELECT COALESCE(MAX(fencing_token), 0) AS token FROM attempts WHERE run_id = ? AND task_id = ?",
                (run_id, task_id),
            ).fetchone()
            token = int(previous["token"] if previous is not None else 0) + 1
            attempt_id = f"attempt-{uuid4().hex}"
            connection.execute(
                "INSERT INTO attempts (attempt_id, run_id, task_id, kind, state, fencing_token, result_json, created_at, updated_at) VALUES (?, ?, ?, 'execute', ?, ?, '{}', ?, ?)",
                (attempt_id, run_id, task_id, AttemptState.RUNNING.value, token, now, now),
            )
            connection.execute(
                "UPDATE tasks SET state = ?, gate_status = 'execute_started', updated_at = ? WHERE run_id = ? AND task_id = ?",
                (TaskState.IN_PROGRESS.value, now, run_id, task_id),
            )
            connection.execute(
                "UPDATE runs SET state = ?, active_task_id = ?, updated_at = ? WHERE run_id = ?",
                (RunState.EXECUTING.value, task_id, now, run_id),
            )
        return {"attempt_id": attempt_id, "fencing_token": token, "task_id": task_id}

    def start_gate(self, run_id: str, task_id: str) -> dict[str, Any]:
        now = utc_now_iso()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            task = connection.execute(
                "SELECT * FROM tasks WHERE run_id = ? AND task_id = ?",
                (run_id, task_id),
            ).fetchone()
            if task is None or task["state"] != TaskState.IN_REVIEW.value:
                raise ValueError(f"task is not ready for gate: {task_id}")
            active = connection.execute(
                "SELECT * FROM attempts WHERE run_id = ? AND task_id = ? AND kind = 'gate' AND state IN ('running', 'waiting') ORDER BY created_at DESC LIMIT 1",
                (run_id, task_id),
            ).fetchone()
            if active is not None:
                return _attempt_dict(active)
            previous = connection.execute(
                "SELECT COALESCE(MAX(fencing_token), 0) AS token FROM attempts WHERE run_id = ? AND task_id = ?",
                (run_id, task_id),
            ).fetchone()
            token = int(previous["token"] if previous is not None else 0) + 1
            attempt_id = f"attempt-{uuid4().hex}"
            run = connection.execute("SELECT plan_version FROM runs WHERE run_id = ?", (run_id,)).fetchone()
            plan_version = int(run["plan_version"] or 0) if run is not None else 0
            connection.execute(
                "INSERT INTO attempts (attempt_id, run_id, task_id, kind, state, fencing_token, result_json, created_at, updated_at) VALUES (?, ?, ?, 'gate', ?, ?, ?, ?, ?)",
                (attempt_id, run_id, task_id, AttemptState.RUNNING.value, token, _dump({"plan_version": plan_version}), now, now),
            )
            connection.execute(
                "UPDATE tasks SET gate_status = 'gate_started', updated_at = ? WHERE run_id = ? AND task_id = ?",
                (now, run_id, task_id),
            )
            row = connection.execute("SELECT * FROM attempts WHERE attempt_id = ?", (attempt_id,)).fetchone()
        return _attempt_dict(row) if row is not None else {}

    def record_execute(self, run_id: str, attempt_id: str, fencing_token: int, *, ready_for_gate: bool, result: dict[str, Any] | None = None) -> dict[str, Any]:
        attempt = self._attempt(run_id, attempt_id, fencing_token, kind="execute")
        if self._result_attempt_is_duplicate(attempt):
            return self.get_task(run_id, str(attempt["task_id"])) or {}
        self._require_running_attempt(attempt)
        now = utc_now_iso()
        state = TaskState.IN_REVIEW.value if ready_for_gate else TaskState.BLOCKED.value
        run_state = RunState.EXECUTING.value if ready_for_gate else RunState.BLOCKED.value
        reason = "ready_for_gate" if ready_for_gate else "execute_failed"
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if self._guard_attempt_state(connection, attempt_id):
                row = connection.execute(
                    "SELECT * FROM tasks WHERE run_id = ? AND task_id = ?",
                    (run_id, attempt["task_id"]),
                ).fetchone()
                return _task(row) if row is not None else {}
            connection.execute(
                "UPDATE attempts SET state = ?, result_json = ?, updated_at = ? WHERE attempt_id = ?",
                (AttemptState.SUCCEEDED.value if ready_for_gate else AttemptState.FAILED.value, _dump(result or {}), now, attempt["attempt_id"]),
            )
            connection.execute(
                "UPDATE tasks SET state = ?, gate_status = ?, result_json = ?, updated_at = ? WHERE run_id = ? AND task_id = ?",
                (state, reason, _dump(result or {}), now, run_id, attempt["task_id"]),
            )
            connection.execute(
                "UPDATE runs SET state = ?, active_task_id = ?, latest_reason = ?, updated_at = ? WHERE run_id = ?",
                (run_state, "" if run_state == RunState.DONE.value else attempt["task_id"], reason, now, run_id),
            )
        return self.get_task(run_id, attempt["task_id"]) or {}

    def record_gate(
        self,
        run_id: str,
        attempt_id: str,
        fencing_token: int,
        *,
        passed: bool,
        score: int,
        threshold: int = 3,
        command_passed: int,
        command_total: int,
        evidence: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        attempt = self._attempt(run_id, attempt_id, fencing_token, kind="gate")
        if self._result_attempt_is_duplicate(attempt):
            return self.get_task(run_id, str(attempt["task_id"])) or {}
        self._require_running_attempt(attempt)
        score = gate_number(score)
        threshold = gate_number(threshold)
        now = utc_now_iso()
        effective_passed = bool(passed and score >= threshold)
        stale_reason = ""
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if self._guard_attempt_state(connection, attempt_id):
                row = connection.execute(
                    "SELECT * FROM tasks WHERE run_id = ? AND task_id = ?",
                    (run_id, attempt["task_id"]),
                ).fetchone()
                return _task(row) if row is not None else {}
            attempt_payload = _load(str(attempt.get("result_json") or "{}"))
            plan_version = int(attempt_payload.get("plan_version") or 0)
            run = connection.execute("SELECT plan_version FROM runs WHERE run_id = ?", (run_id,)).fetchone()
            current_plan_version = int(run["plan_version"] or 0) if run is not None else 0
            if plan_version <= 0:
                stale_reason = "missing_gate_plan_version"
            elif plan_version != current_plan_version:
                stale_reason = "stale_plan_version"
            if stale_reason:
                connection.execute(
                    "UPDATE attempts SET state = ?, result_json = ?, updated_at = ? WHERE attempt_id = ?",
                    (
                        AttemptState.STALE.value,
                        _dump(
                            {
                                "error_code": stale_reason,
                                "plan_version": plan_version,
                                "current_plan_version": current_plan_version,
                            }
                        ),
                        now,
                        attempt_id,
                    ),
                )
                connection.execute(
                    "UPDATE tasks SET state = ?, gate_status = ?, updated_at = ? WHERE run_id = ? AND task_id = ?",
                    (TaskState.TODO.value, stale_reason, now, run_id, attempt["task_id"]),
                )
                connection.execute(
                    "UPDATE runs SET state = ?, active_task_id = '', latest_reason = ?, updated_at = ? WHERE run_id = ?",
                    (RunState.EXECUTING.value, stale_reason, now, run_id),
                )
            else:
                catalog_row = connection.execute(
                    "SELECT catalog_json FROM acceptance_catalog WHERE run_id = ? AND version = ?",
                    (run_id, plan_version),
                ).fetchone()
                manifest_row = connection.execute(
                    "SELECT manifest_json FROM plan_revisions WHERE run_id = ? AND version = ?",
                    (run_id, plan_version),
                ).fetchone()
                stored_evidence = canonical_gate_evidence(
                    evidence,
                    passed=effective_passed,
                    score=score,
                    threshold=threshold,
                    attempt_id=attempt_id,
                    plan_version=plan_version,
                    catalog=_load(str(catalog_row["catalog_json"])) if catalog_row is not None else None,
                    manifest_refs=_load_list(str(manifest_row["manifest_json"])) if manifest_row is not None else [],
                    command_passed=command_passed,
                    command_total=command_total,
                )
                connection.execute(
                    "INSERT OR REPLACE INTO gate_evidence (run_id, task_id, attempt_id, passed, score, threshold, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (run_id, attempt["task_id"], attempt_id, 1 if effective_passed else 0, score, threshold, _dump(stored_evidence), now),
                )
                for artifact_ref in stored_evidence["artifact_refs"]:
                    connection.execute(
                        "INSERT OR REPLACE INTO artifacts (run_id, task_id, attempt_id, artifact_ref, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                        (run_id, attempt["task_id"], attempt_id, artifact_ref, _dump(artifact_metadata(stored_evidence)), now),
                    )
                connection.execute(
                    "UPDATE attempts SET state = ?, result_json = ?, updated_at = ? WHERE attempt_id = ?",
                    (AttemptState.SUCCEEDED.value if effective_passed else AttemptState.FAILED.value, _dump(stored_evidence), now, attempt_id),
                )
                task = connection.execute(
                    "SELECT * FROM tasks WHERE run_id = ? AND task_id = ?",
                    (run_id, attempt["task_id"]),
                ).fetchone()
                if task is None:
                    raise KeyError(attempt["task_id"])
                if effective_passed:
                    connection.execute(
                        "UPDATE tasks SET state = ?, gate_status = ?, updated_at = ? WHERE run_id = ? AND task_id = ?",
                        (TaskState.DONE.value, f"passed:{score}", now, run_id, attempt["task_id"]),
                    )
                    remaining = connection.execute(
                        "SELECT COUNT(*) AS count FROM tasks WHERE run_id = ? AND state != ?",
                        (run_id, TaskState.DONE.value),
                    ).fetchone()["count"]
                    run_state = RunState.DONE.value if remaining == 0 else RunState.EXECUTING.value
                    reason = "parent_done" if remaining == 0 else "task_done"
                elif int(task["rework_count"]) < 1:
                    connection.execute(
                        "UPDATE tasks SET state = ?, rework_count = rework_count + 1, gate_status = ?, updated_at = ? WHERE run_id = ? AND task_id = ?",
                        (TaskState.IN_PROGRESS.value, f"gate_failed_rework:{score}", now, run_id, attempt["task_id"]),
                    )
                    run_state, reason = RunState.EXECUTING.value, "gate_failed_rework"
                else:
                    connection.execute(
                        "UPDATE tasks SET state = ?, gate_status = ?, updated_at = ? WHERE run_id = ? AND task_id = ?",
                        (TaskState.BLOCKED.value, f"gate_failed:{score}", now, run_id, attempt["task_id"]),
                    )
                    run_state, reason = RunState.BLOCKED.value, "gate_failed"
                connection.execute(
                    "UPDATE runs SET state = ?, latest_reason = ?, updated_at = ? WHERE run_id = ?",
                    (run_state, reason, now, run_id),
                )
        if stale_reason:
            raise StaleAttemptError(stale_reason)
        return self.get_task(run_id, attempt["task_id"]) or {}

    def _attempt(self, run_id: str, attempt_id: str, fencing_token: int, *, kind: str | None = None) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM attempts WHERE run_id = ? AND attempt_id = ?",
                (run_id, attempt_id),
            ).fetchone()
        if row is None or int(row["fencing_token"]) != int(fencing_token):
            raise StaleAttemptError("stale_fencing_token")
        if kind is not None and str(row["kind"]) != kind:
            raise StaleAttemptError("attempt_kind_mismatch")
        return {key: row[key] for key in row.keys()}

    @staticmethod
    def _result_attempt_is_duplicate(attempt: dict[str, Any]) -> bool:
        return str(attempt.get("state") or "") in {
            AttemptState.SUCCEEDED.value,
            AttemptState.FAILED.value,
        }

    @staticmethod
    def _require_running_attempt(attempt: dict[str, Any]) -> None:
        if str(attempt.get("state") or "") != AttemptState.RUNNING.value:
            raise StaleAttemptError("stale_attempt_state")

    @staticmethod
    def _guard_attempt_state(connection: sqlite3.Connection, attempt_id: str) -> bool:
        row = connection.execute(
            "SELECT state FROM attempts WHERE attempt_id = ?",
            (attempt_id,),
        ).fetchone()
        if row is None:
            raise StaleAttemptError("stale_attempt_state")
        state = str(row["state"] or "")
        if state in {AttemptState.SUCCEEDED.value, AttemptState.FAILED.value}:
            return True
        if state != AttemptState.RUNNING.value:
            raise StaleAttemptError("stale_attempt_state")
        return False

    def _init_db(self) -> None:
        with self.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS settings (
                  id INTEGER PRIMARY KEY CHECK (id = 1),
                  podium_url TEXT NOT NULL DEFAULT '',
                  podium_runtime_id TEXT NOT NULL DEFAULT '',
                  podium_runtime_token TEXT NOT NULL DEFAULT '',
                  podium_proxy_token TEXT NOT NULL DEFAULT '',
                  managed_mode INTEGER NOT NULL DEFAULT 0,
                  conductor_id TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS instances (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  repo_source_type TEXT NOT NULL,
                  repo_source_value TEXT NOT NULL,
                  resolved_repo_path TEXT NOT NULL,
                  instance_dir TEXT NOT NULL,
                  workspace_root TEXT NOT NULL,
                  persistence_path TEXT NOT NULL,
                  log_path TEXT NOT NULL,
                  http_port INTEGER NOT NULL,
                  linear_project TEXT NOT NULL,
                  linear_filters_json TEXT NOT NULL,
                  process_status TEXT NOT NULL,
                  pid INTEGER,
                  last_exit_code INTEGER,
                  last_error TEXT,
                  restart_count INTEGER NOT NULL DEFAULT 0,
                  restart_window_started_at TEXT,
                  restart_next_at TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_instances_http_port ON instances(http_port);
                CREATE INDEX IF NOT EXISTS idx_instances_process_status ON instances(process_status);

                CREATE TABLE IF NOT EXISTS runs (
                  run_id TEXT PRIMARY KEY,
                  parent_issue_id TEXT NOT NULL UNIQUE,
                  issue_identifier TEXT NOT NULL,
                  instance_id TEXT NOT NULL,
                  state TEXT NOT NULL,
                  active_task_id TEXT NOT NULL,
                  plan_version INTEGER NOT NULL,
                  policy_revision INTEGER NOT NULL,
                  latest_reason TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS plan_revisions (
                  run_id TEXT NOT NULL,
                  version INTEGER NOT NULL,
                  status TEXT NOT NULL,
                  reason TEXT NOT NULL,
                  approval_id TEXT NOT NULL,
                  policy_revision INTEGER NOT NULL,
                  plan_json TEXT NOT NULL,
                  manifest_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  PRIMARY KEY (run_id, version)
                );
                CREATE TABLE IF NOT EXISTS tasks (
                  run_id TEXT NOT NULL,
                  task_id TEXT NOT NULL,
                  parent_issue_id TEXT NOT NULL,
                  position INTEGER NOT NULL,
                  state TEXT NOT NULL,
                  gate_status TEXT NOT NULL,
                  rework_count INTEGER NOT NULL,
                  linear_issue_id TEXT NOT NULL DEFAULT '',
                  linear_identifier TEXT NOT NULL DEFAULT '',
                  linear_state TEXT NOT NULL DEFAULT '',
                  task_json TEXT NOT NULL,
                  result_json TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  PRIMARY KEY (run_id, task_id)
                );
                CREATE TABLE IF NOT EXISTS attempts (
                  attempt_id TEXT PRIMARY KEY,
                  run_id TEXT NOT NULL,
                  task_id TEXT NOT NULL,
                  kind TEXT NOT NULL,
                  state TEXT NOT NULL,
                  fencing_token INTEGER NOT NULL,
                  result_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS runtime_waits (
                  wait_id TEXT PRIMARY KEY,
                  run_id TEXT NOT NULL,
                  task_id TEXT NOT NULL,
                  kind TEXT NOT NULL,
                  reason TEXT NOT NULL,
                  state TEXT NOT NULL,
                  linear_issue_id TEXT NOT NULL DEFAULT '',
                  linear_identifier TEXT NOT NULL DEFAULT '',
                  created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS acceptance_catalog (
                  run_id TEXT NOT NULL,
                  version INTEGER NOT NULL,
                  catalog_json TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  PRIMARY KEY (run_id, version)
                );
                CREATE TABLE IF NOT EXISTS gate_evidence (
                  run_id TEXT NOT NULL,
                  task_id TEXT NOT NULL,
                  attempt_id TEXT NOT NULL,
                  passed INTEGER NOT NULL,
                  score INTEGER NOT NULL,
                  threshold INTEGER NOT NULL,
                  evidence_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  PRIMARY KEY (run_id, task_id, attempt_id)
                );
                CREATE TABLE IF NOT EXISTS artifacts (
                  run_id TEXT NOT NULL,
                  task_id TEXT NOT NULL,
                  attempt_id TEXT NOT NULL,
                  artifact_ref TEXT NOT NULL,
                  metadata_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  PRIMARY KEY (run_id, task_id, attempt_id, artifact_ref)
                );
                CREATE TABLE IF NOT EXISTS performer_control_state (
                  id INTEGER PRIMARY KEY CHECK (id = 1),
                  performer_kind TEXT NOT NULL,
                  binding_generation INTEGER NOT NULL,
                  capability_version INTEGER NOT NULL,
                  execution_policy_sha256 TEXT NOT NULL,
                  status TEXT NOT NULL CHECK (
                    status IN ('unchecked', 'checking', 'ready', 'failed')
                  ),
                  last_check_status TEXT NOT NULL CHECK (
                    last_check_status IN ('none', 'passed', 'failed')
                  ),
                  last_check_started_at TEXT,
                  last_check_finished_at TEXT,
                  error_code TEXT NOT NULL,
                  sanitized_reason TEXT NOT NULL,
                  action_required INTEGER NOT NULL CHECK (action_required IN (0, 1)),
                  retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
                  attempt_number INTEGER,
                  next_action TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                """
            )
        self.reset_performer_control_state()


def _run(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()} | {"payload": _load(row["payload_json"])}


def _task(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()} | {
        "task": _load(row["task_json"]),
        "result": _load(row["result_json"]),
    }


def _attempt_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()} | {"result": _load(row["result_json"])}


def _performer_control_state(row: sqlite3.Row) -> dict[str, Any]:
    error_code = str(row["error_code"] or "")
    sanitized_reason = str(row["sanitized_reason"] or "")
    next_action = str(row["next_action"] or "")
    return {
        "performer_kind": str(row["performer_kind"]),
        "binding_generation": int(row["binding_generation"]),
        "capability_version": int(row["capability_version"]),
        "execution_policy_sha256": str(row["execution_policy_sha256"]),
        "status": str(row["status"]),
        "last_check_status": str(row["last_check_status"]),
        "last_check_started_at": row["last_check_started_at"],
        "last_check_finished_at": row["last_check_finished_at"],
        "error_code": error_code or None,
        "sanitized_reason": sanitized_reason or None,
        "action_required": bool(row["action_required"]),
        "retryable": bool(row["retryable"]),
        "attempt_number": row["attempt_number"],
        "next_action": next_action or None,
        "updated_at": str(row["updated_at"]),
    }


def _performer_prior_phase(
    run: dict[str, Any],
    task: dict[str, Any] | None,
) -> str:
    if task is None:
        return str(run.get("state") or RunState.PLANNING.value)
    if task.get("state") == TaskState.IN_REVIEW.value:
        return "gating"
    return "executing"


__all__ = ["ConductorStore", "StaleAttemptError"]
