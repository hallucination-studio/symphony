from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from performer_api.workflow import Plan

from .models import AttemptState, RunState, StaleAttemptError, TaskState


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _dump(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _load(value: str) -> dict[str, Any]:
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return decoded if isinstance(decoded, dict) else {}


class ConductorStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def create_run(self, parent_issue_id: str, issue_identifier: str, *, instance_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            existing = connection.execute(
                "SELECT * FROM runs WHERE parent_issue_id = ?",
                (parent_issue_id,),
            ).fetchone()
            if existing is not None:
                return _run(existing)
            run_id = f"run-{uuid4().hex}"
            now = _now()
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

    def update_run_payload(self, run_id: str, updates: dict[str, Any]) -> None:
        current = self.get_run(run_id) or {}
        payload = dict(current.get("payload") or {})
        payload.update(updates)
        with self.connect() as connection:
            connection.execute(
                "UPDATE runs SET payload_json = ?, updated_at = ? WHERE run_id = ?",
                (_dump(payload), _now(), run_id),
            )

    def fail_run(self, run_id: str, reason: str) -> None:
        with self.connect() as connection:
            connection.execute(
                "UPDATE runs SET state = ?, latest_reason = ?, updated_at = ? WHERE run_id = ?",
                (RunState.FAILED.value, reason, _now(), run_id),
            )

    def managed_run_view(self) -> dict[str, Any]:
        runs: list[dict[str, Any]] = []
        for run in self.list_runs():
            run_id = str(run["run_id"])
            runs.append(
                {
                    **run,
                    "tasks": self.list_tasks(run_id),
                    "plan": self.get_plan(run_id),
                    "runtime_waits": self.list_runtime_waits(run_id),
                }
            )
        return {"runs": runs}

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
                (issue_id, identifier, state, _now(), run_id, task_id),
            )

    def update_task_linear_state(self, run_id: str, task_id: str, state: str) -> None:
        with self.connect() as connection:
            connection.execute(
                "UPDATE tasks SET linear_state = ?, updated_at = ? WHERE run_id = ? AND task_id = ?",
                (state, _now(), run_id, task_id),
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
        now = _now()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT COALESCE(MAX(version), 0) AS version FROM plan_revisions WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            version = int(row["version"] if row is not None else 0) + 1
            status = "awaiting_approval" if approval_required else "active"
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
        now = _now()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "UPDATE plan_revisions SET status = 'superseded' WHERE run_id = ? AND status = 'active'",
                (run_id,),
            )
            changed = connection.execute(
                "UPDATE plan_revisions SET status = 'active', approval_id = ? WHERE run_id = ? AND version = ?",
                (approval_id, run_id, version),
            ).rowcount
            if not changed:
                raise ValueError("plan revision not found")
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
        now = _now()
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
        attempt = self._attempt(run_id, attempt_id, fencing_token)
        version = self.save_plan(
            run_id,
            plan,
            policy_revision=policy_revision,
            approval_required=plan.approval_required,
            manifest_refs=manifest_refs,
        )
        now = _now()
        with self.connect() as connection:
            connection.execute(
                "UPDATE attempts SET state = ?, result_json = ?, updated_at = ? WHERE attempt_id = ?",
                (AttemptState.SUCCEEDED.value, _dump(plan.to_dict()), now, attempt["attempt_id"]),
            )
        return version

    def record_runtime_wait(self, run_id: str, attempt_id: str, fencing_token: int, *, kind: str, reason: str) -> None:
        attempt = self._attempt(run_id, attempt_id, fencing_token)
        now = _now()
        wait_id = f"wait-{uuid4().hex}"
        with self.connect() as connection:
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

    def resume_runtime_wait(self, run_id: str) -> bool:
        now = _now()
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
                    (AttemptState.RUNNING.value, now, run_id, wait["task_id"]),
                )
                if wait["task_id"]:
                    gate_wait = connection.execute(
                        "SELECT 1 FROM attempts WHERE run_id = ? AND task_id = ? AND kind = 'gate' AND state = 'running' LIMIT 1",
                        (run_id, wait["task_id"]),
                    ).fetchone()
                    state = TaskState.IN_REVIEW.value if gate_wait else TaskState.IN_PROGRESS.value
                    connection.execute(
                        "UPDATE tasks SET state = ?, updated_at = ? WHERE run_id = ? AND task_id = ?",
                        (state, now, run_id, wait["task_id"]),
                    )
            run = connection.execute("SELECT plan_version FROM runs WHERE run_id = ?", (run_id,)).fetchone()
            next_state = RunState.PLANNING.value if not run or int(run["plan_version"] or 0) == 0 else RunState.EXECUTING.value
            connection.execute(
                "UPDATE runs SET state = ?, latest_reason = 'runtime_wait_resumed', updated_at = ? WHERE run_id = ?",
                (next_state, now, run_id),
            )
        return True

    def start_task(self, run_id: str, task_id: str) -> dict[str, Any]:
        now = _now()
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
        now = _now()
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
            connection.execute(
                "INSERT INTO attempts (attempt_id, run_id, task_id, kind, state, fencing_token, result_json, created_at, updated_at) VALUES (?, ?, ?, 'gate', ?, ?, '{}', ?, ?)",
                (attempt_id, run_id, task_id, AttemptState.RUNNING.value, token, now, now),
            )
            connection.execute(
                "UPDATE tasks SET gate_status = 'gate_started', updated_at = ? WHERE run_id = ? AND task_id = ?",
                (now, run_id, task_id),
            )
            row = connection.execute("SELECT * FROM attempts WHERE attempt_id = ?", (attempt_id,)).fetchone()
        return _attempt_dict(row) if row is not None else {}

    def record_execute(self, run_id: str, attempt_id: str, fencing_token: int, *, ready_for_gate: bool, result: dict[str, Any] | None = None) -> dict[str, Any]:
        attempt = self._attempt(run_id, attempt_id, fencing_token)
        now = _now()
        state = TaskState.IN_REVIEW.value if ready_for_gate else TaskState.BLOCKED.value
        run_state = RunState.EXECUTING.value if ready_for_gate else RunState.BLOCKED.value
        reason = "ready_for_gate" if ready_for_gate else "execute_failed"
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "UPDATE attempts SET state = ?, result_json = ?, updated_at = ? WHERE attempt_id = ?",
                (AttemptState.SUCCEEDED.value if ready_for_gate else AttemptState.FAILED.value, _dump(result or {}), now, attempt["attempt_id"]),
            )
            connection.execute(
                "UPDATE tasks SET state = ?, gate_status = ?, result_json = ?, updated_at = ? WHERE run_id = ? AND task_id = ?",
                (state, reason, _dump(result or {}), now, run_id, attempt["task_id"]),
            )
            connection.execute(
                "UPDATE runs SET state = ?, latest_reason = ?, updated_at = ? WHERE run_id = ?",
                (run_state, reason, now, run_id),
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
        evidence: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        attempt = self._attempt(run_id, attempt_id, fencing_token)
        now = _now()
        effective_passed = bool(passed and score >= threshold)
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "INSERT OR REPLACE INTO gate_evidence (run_id, task_id, attempt_id, passed, score, threshold, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (run_id, attempt["task_id"], attempt_id, 1 if effective_passed else 0, score, threshold, _dump(evidence or {}), now),
            )
            artifact_refs = evidence.get("artifact_refs", []) if isinstance(evidence, dict) else []
            for artifact_ref in artifact_refs:
                connection.execute(
                    "INSERT OR REPLACE INTO artifacts (run_id, task_id, attempt_id, artifact_ref, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (run_id, attempt["task_id"], attempt_id, str(artifact_ref), _dump(evidence), now),
                )
            connection.execute(
                "UPDATE attempts SET state = ?, result_json = ?, updated_at = ? WHERE attempt_id = ?",
                (AttemptState.SUCCEEDED.value if effective_passed else AttemptState.FAILED.value, _dump(evidence or {}), now, attempt_id),
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
        return self.get_task(run_id, attempt["task_id"]) or {}

    def _attempt(self, run_id: str, attempt_id: str, fencing_token: int) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM attempts WHERE run_id = ? AND attempt_id = ?",
                (run_id, attempt_id),
            ).fetchone()
        if row is None or int(row["fencing_token"]) != int(fencing_token):
            raise StaleAttemptError("stale_fencing_token")
        return {key: row[key] for key in row.keys()}

    def _init_db(self) -> None:
        with self.connect() as connection:
            connection.executescript(
                """
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
                """
            )
            for column in ("linear_issue_id", "linear_identifier", "linear_state"):
                try:
                    connection.execute(f"ALTER TABLE tasks ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
                except sqlite3.OperationalError as exc:
                    if "duplicate column name" not in str(exc).lower():
                        raise


def _run(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()} | {"payload": _load(row["payload_json"])}


def _task(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()} | {
        "task": _load(row["task_json"]),
        "result": _load(row["result_json"]),
    }


def _attempt_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()} | {"result": _load(row["result_json"])}


__all__ = ["ConductorStore", "StaleAttemptError"]
