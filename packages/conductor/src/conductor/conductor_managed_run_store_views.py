from __future__ import annotations

from typing import Any

from performer_api.managed_runs import Checkpoint, WorkItemState

from conductor.conductor_managed_run_store_rows import (
    _checkpoint_result_from_row,
    _json_dumps,
    _json_loads,
    _now,
    _projection_from_row,
    _run_attempts_for_view,
    checkpoint_key_for,
)


class ConductorManagedRunStoreViewMixin:
    def record_linear_projection(
        self,
        run_id: str,
        work_item_id: str,
        *,
        linear_issue_id: str,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        projection_id = f"{run_id}:{work_item_id or 'parent'}"
        now = _now()
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO managed_run_linear_projections (
                  projection_id, run_id, work_item_id, linear_issue_id, metadata_json, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(projection_id) DO UPDATE SET
                  linear_issue_id = excluded.linear_issue_id,
                  metadata_json = excluded.metadata_json,
                  updated_at = excluded.updated_at
                """,
                (projection_id, run_id, work_item_id, linear_issue_id, _json_dumps(metadata), now),
            )
        return {
            "projection_id": projection_id,
            "run_id": run_id,
            "work_item_id": work_item_id,
            "linear_issue_id": linear_issue_id,
            "metadata": _json_loads(_json_dumps(metadata)),
            "updated_at": now,
        }

    def list_linear_projections(self, run_id: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM managed_run_linear_projections WHERE run_id = ? ORDER BY projection_id",
                (run_id,),
            ).fetchall()
        return [_projection_from_row(row) for row in rows]

    def record_checkpoint_result(
        self,
        run_id: str,
        *,
        after: list[str],
        verify: list[str],
        passed: bool,
        reason: str = "",
    ) -> dict[str, Any]:
        checkpoint_key = checkpoint_key_for(Checkpoint(after=after, verify=verify))
        now = _now()
        payload = {
            "checkpoint_key": checkpoint_key,
            "run_id": run_id,
            "after": list(after),
            "verify": list(verify),
            "passed": bool(passed),
            "reason": reason,
            "updated_at": now,
        }
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO managed_run_checkpoint_results (
                  run_id, checkpoint_key, after_json, verify_json, passed, reason, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id, checkpoint_key) DO UPDATE SET
                  after_json = excluded.after_json,
                  verify_json = excluded.verify_json,
                  passed = excluded.passed,
                  reason = excluded.reason,
                  updated_at = excluded.updated_at
                """,
                (
                    run_id,
                    checkpoint_key,
                    _json_dumps({"items": list(after)}),
                    _json_dumps({"commands": list(verify)}),
                    1 if passed else 0,
                    reason,
                    now,
                ),
            )
        return payload

    def list_checkpoint_results(self, run_id: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM managed_run_checkpoint_results WHERE run_id = ? ORDER BY checkpoint_key",
                (run_id,),
            ).fetchall()
        return [_checkpoint_result_from_row(row) for row in rows]

    def recovery_cursor(self, run_id: str) -> dict[str, Any]:
        items = self.list_work_items(run_id)
        verified = [item["work_item_id"] for item in items if item["state"] == WorkItemState.DONE.value]
        next_item = next((item for item in items if item["state"] != WorkItemState.DONE.value), None)
        run = self.get_run(run_id) or {}
        return {
            "run_id": run_id,
            "backend_session_id": str(run.get("backend_session_id") or ""),
            "verified_work_item_ids": verified,
            "next_work_item_id": next_item["work_item_id"] if next_item else None,
            "state": run.get("state"),
        }

    def managed_run_view(self) -> dict[str, Any]:
        runs = []
        attempts: list[dict[str, Any]] = []
        for run in self.list_runs():
            payload = run.get("payload") if isinstance(run.get("payload"), dict) else {}
            run_attempts = _run_attempts_for_view(str(run["run_id"]), payload)
            attempts.extend(run_attempts)
            runs.append(
                {
                    **run,
                    "work_items": self.list_work_items(str(run["run_id"])),
                    "linear_projections": self.list_linear_projections(str(run["run_id"])),
                    "checkpoint_results": self.list_checkpoint_results(str(run["run_id"])),
                    "attempts": run_attempts,
                }
            )
        return {"runs": runs, "attempts": attempts}

