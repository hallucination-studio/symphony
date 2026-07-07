from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)


class WorkspaceExecutionState:
    def __init__(self, workspace_path: Path):
        self.workspace_path = workspace_path
        self.path = workspace_path / ".symphony" / "execution.json"

    def sdk_thread_id(self, *, issue_id: str) -> str | None:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict):
            return None
        if payload.get("issue_id") != issue_id:
            return None
        if payload.get("backend") != "sdk":
            return None
        if payload.get("status") not in {"active", "resume_pending", "completed"}:
            return None
        thread_id = payload.get("thread_id")
        return thread_id if isinstance(thread_id, str) and thread_id else None

    def write_sdk_thread(self, *, issue_id: str, result: Any) -> None:
        thread_id = getattr(result, "thread_id", None)
        if not isinstance(thread_id, str) or not thread_id:
            return
        payload = self._sdk_thread_payload(
            issue_id=issue_id,
            thread_id=thread_id,
            turn_id=getattr(result, "turn_id", None),
            status="resume_pending",
            prior_attempt_summary=getattr(result, "final_response", None),
        )
        self._write_payload(payload)

    def write_sdk_thread_failure(
        self,
        *,
        issue_id: str,
        thread_id: str,
        turn_id: str | None = None,
        error: str = "",
    ) -> None:
        if not thread_id:
            return
        payload = self._sdk_thread_payload(
            issue_id=issue_id,
            thread_id=thread_id,
            turn_id=turn_id,
            status="failed",
            failure_summary=error,
        )
        self._write_payload(payload)

    def _sdk_thread_payload(
        self,
        *,
        issue_id: str,
        thread_id: str,
        turn_id: str | None,
        status: str,
        prior_attempt_summary: str | None = None,
        failure_summary: str | None = None,
    ) -> dict[str, Any]:
        payload = {
            "issue_id": issue_id,
            "thread_id": thread_id,
            "backend": "sdk",
            "workspace_path": str(self.workspace_path),
            "last_turn_id": turn_id,
            "status": status,
            "notes": [],
        }
        if prior_attempt_summary is not None:
            payload["prior_attempt_summary"] = prior_attempt_summary
        if failure_summary is not None:
            payload["failure_summary"] = failure_summary
        return payload

    def _write_payload(self, payload: dict[str, Any]) -> None:
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
            tmp.replace(self.path)
        except OSError:
            logger.warning("workspace_execution_state_write_failed workspace=%s", self.workspace_path)
