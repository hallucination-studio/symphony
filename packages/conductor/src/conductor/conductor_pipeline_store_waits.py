from __future__ import annotations

from .conductor_pipeline_store_common import *


class WaitsMixin:
    def create_human_wait(
        self,
        node_id: str,
        *,
        reason: str,
        child_issue_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        reason_enum = HumanEscalationReason(reason)
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            payload = self._create_human_wait_on_connection(
                connection,
                node_id,
                reason=reason_enum,
                child_issue_id=child_issue_id,
                details=details,
            )
        return payload

    def _create_human_wait_on_connection(
        self,
        connection: sqlite3.Connection,
        node_id: str,
        *,
        reason: HumanEscalationReason,
        child_issue_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        wait_id = f"human-wait-{node_id}-{uuid4().hex}"
        payload = {
            "wait_id": wait_id,
            "node_id": node_id,
            "reason": reason.value,
            "child_issue_id": child_issue_id,
            "status": "waiting",
            "created_at": _now(),
            "resolved_at": None,
            "resolution": None,
            "details": dict(details or {}),
        }
        connection.execute(
            """
            INSERT INTO human_waits (wait_id, node_id, status, payload_json, created_at, resolved_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (wait_id, node_id, "waiting", _json_dumps(payload), payload["created_at"], None),
        )
        self._update_node_state_on_connection(
            connection,
            node_id,
            GraphNodeState.NEED_HUMAN,
            human_reason=reason,
        )
        return payload

    def resume_human_wait(self, wait_id: str, *, resolution: str) -> dict[str, Any]:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT payload_json FROM human_waits WHERE wait_id = ?", (wait_id,)).fetchone()
            if row is None:
                raise KeyError(wait_id)
            payload = _json_loads(row["payload_json"])
            payload.update({"status": "resolved", "resolution": resolution, "resolved_at": _now()})
            connection.execute(
                "UPDATE human_waits SET status = ?, payload_json = ?, resolved_at = ? WHERE wait_id = ?",
                ("resolved", _json_dumps(payload), payload["resolved_at"], wait_id),
            )
            if payload.get("reason") == HumanEscalationReason.LINEAR_SYNC_CONFLICT.value:
                details = payload.get("details") if isinstance(payload.get("details"), dict) else {}
                integration_id = str(details.get("integration_id") or "").strip()
                if integration_id:
                    integration_row = connection.execute(
                        "SELECT payload_json FROM integration_queue WHERE integration_id = ?",
                        (integration_id,),
                    ).fetchone()
                    if integration_row is not None:
                        integration_payload = _json_loads(integration_row["payload_json"])
                        integration_payload.update(
                            {
                                "status": "resolved",
                                "human_resolution": resolution,
                                "completed_at": payload["resolved_at"],
                            }
                        )
                        connection.execute(
                            """
                            UPDATE integration_queue
                            SET status = ?, payload_json = ?, completed_at = ?
                            WHERE integration_id = ?
                            """,
                            ("resolved", _json_dumps(integration_payload), payload["resolved_at"], integration_id),
                        )
            node_id = str(payload["node_id"])
            self._update_node_state_on_connection(
                connection,
                node_id,
                _resume_state_for_human_wait(payload),
                human_reason=None,
            )
        return payload

    def attach_human_wait_child_issue(self, wait_id: str, *, child_issue_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT payload_json FROM human_waits WHERE wait_id = ?", (wait_id,)).fetchone()
            if row is None:
                raise KeyError(wait_id)
            payload = _json_loads(row["payload_json"])
            payload["child_issue_id"] = child_issue_id
            connection.execute(
                "UPDATE human_waits SET payload_json = ? WHERE wait_id = ?",
                (_json_dumps(payload), wait_id),
            )
        return payload

    def list_human_waits(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute("SELECT payload_json FROM human_waits ORDER BY created_at, wait_id").fetchall()
        return [_json_loads(row["payload_json"]) for row in rows]

    def record_runtime_wait(
        self,
        *,
        attempt_id: str,
        node_id: str,
        mode: RuntimeMode,
        wait_kind: str,
        message: str | None = None,
        command: str | None = None,
        thread_id: str | None = None,
        turn_id: str | None = None,
        session_id: str | None = None,
        lease_id: str | None = None,
        log_path: str | None = None,
    ) -> bool:
        wait_kind = _normalize_runtime_wait_kind(wait_kind)
        wait_id = f"runtime-wait-{attempt_id}-{wait_kind}"
        now = _now()
        sanitized_message = _sanitize_error(message or "") if message else None
        sanitized_command = _sanitize_error(command or "") if command else None
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT payload_json FROM runtime_waits WHERE wait_id = ?", (wait_id,)).fetchone()
            existing = _json_loads(row["payload_json"]) if row is not None else {}
            payload = {
                "wait_id": wait_id,
                "attempt_id": attempt_id,
                "node_id": node_id,
                "mode": mode.value,
                "wait_kind": wait_kind,
                "status": "waiting",
                "message": sanitized_message,
                "command": sanitized_command,
                "thread_id": thread_id,
                "turn_id": turn_id,
                "session_id": session_id,
                "lease_id": lease_id,
                "log_path": log_path,
                "child_issue_id": existing.get("child_issue_id") or None,
                "created_at": existing.get("created_at") or now,
                "updated_at": now,
                "resolved_at": None,
                "resolution": None,
            }
            comparable_payload = {key: value for key, value in payload.items() if key != "updated_at"}
            comparable_existing = {key: value for key, value in existing.items() if key != "updated_at"}
            changed = comparable_payload != comparable_existing
            connection.execute(
                """
                INSERT INTO runtime_waits (
                  wait_id, attempt_id, node_id, mode, status, payload_json, created_at, updated_at, resolved_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(wait_id) DO UPDATE SET
                  node_id = excluded.node_id,
                  mode = excluded.mode,
                  status = excluded.status,
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at,
                  resolved_at = excluded.resolved_at
                """,
                (
                    wait_id,
                    attempt_id,
                    node_id,
                    mode.value,
                    "waiting",
                    _json_dumps(payload),
                    payload["created_at"],
                    payload["updated_at"],
                    None,
                ),
            )
        return changed

    def resolve_runtime_waits_for_attempt(self, attempt_id: str, *, resolution: str) -> int:
        now = _now()
        resolved = 0
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute(
                "SELECT wait_id, payload_json FROM runtime_waits WHERE attempt_id = ? AND status = ?",
                (attempt_id, "waiting"),
            ).fetchall()
            for row in rows:
                payload = _json_loads(row["payload_json"])
                payload.update({"status": "resolved", "resolution": resolution, "resolved_at": now, "updated_at": now})
                connection.execute(
                    """
                    UPDATE runtime_waits
                    SET status = ?, payload_json = ?, updated_at = ?, resolved_at = ?
                    WHERE wait_id = ?
                    """,
                    ("resolved", _json_dumps(payload), now, now, str(row["wait_id"])),
                )
                resolved += 1
        return resolved

    def resolve_runtime_wait(self, wait_id: str, *, resolution: str) -> dict[str, Any]:
        now = _now()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT payload_json FROM runtime_waits WHERE wait_id = ?", (wait_id,)).fetchone()
            if row is None:
                raise KeyError(wait_id)
            payload = _json_loads(row["payload_json"])
            payload.update({"status": "resolved", "resolution": resolution, "resolved_at": now, "updated_at": now})
            connection.execute(
                """
                UPDATE runtime_waits
                SET status = ?, payload_json = ?, updated_at = ?, resolved_at = ?
                WHERE wait_id = ?
                """,
                ("resolved", _json_dumps(payload), now, now, wait_id),
            )
        return payload

    def list_runtime_waits(self, *, status: str | None = None) -> list[dict[str, Any]]:
        with self.connect() as connection:
            if status is None:
                rows = connection.execute(
                    "SELECT payload_json FROM runtime_waits ORDER BY updated_at DESC, wait_id",
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT payload_json FROM runtime_waits WHERE status = ? ORDER BY updated_at DESC, wait_id",
                    (status,),
                ).fetchall()
        return [_json_loads(row["payload_json"]) for row in rows]

    def active_runtime_wait_for_node(self, node_id: str) -> dict[str, Any] | None:
        waits = [
            wait
            for wait in self.list_runtime_waits(status="waiting")
            if str(wait.get("node_id") or "") == node_id
        ]
        return waits[0] if waits else None

    def attach_runtime_wait_child_issue(self, wait_id: str, *, child_issue_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT payload_json FROM runtime_waits WHERE wait_id = ?", (wait_id,)).fetchone()
            if row is None:
                raise KeyError(wait_id)
            payload = _json_loads(row["payload_json"])
            payload["child_issue_id"] = child_issue_id
            payload["updated_at"] = _now()
            connection.execute(
                """
                UPDATE runtime_waits
                SET payload_json = ?, updated_at = ?
                WHERE wait_id = ?
                """,
                (_json_dumps(payload), payload["updated_at"], wait_id),
            )
        return payload
