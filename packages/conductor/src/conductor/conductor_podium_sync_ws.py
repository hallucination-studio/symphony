from __future__ import annotations

from typing import Any

from .conductor_service_helpers import _optional_int


class PodiumWebSocketMixin:
    async def handle_podium_ws_command(
        self,
        command: dict[str, Any],
        *,
        post_log_chunk: Any | None = None,
    ) -> dict[str, Any]:
        kind = str(command.get("type") or "")
        if kind == "dispatch.available":
            dispatch = command.get("dispatch") if isinstance(command.get("dispatch"), dict) else command
            queued_dispatch = dict(dispatch)
            if not (queued_dispatch.get("issue_id") or queued_dispatch.get("issue_identifier")):
                queued_dispatch["_lease_dispatch"] = True
            self._podium_dispatch_queue.put_nowait(queued_dispatch)
            return {
                "status": "queued",
                "issue_id": dispatch.get("issue_id") or None,
                "issue_identifier": dispatch.get("issue_identifier") or None,
                "agent_session_id": dispatch.get("agent_session_id") or None,
            }
        if kind == "human.answered":
            return self._handle_podium_human_answered(command)
        if kind == "log.fetch":
            instance_id = str(command.get("instance_id") or "")
            logs = self.query_instance_logs(
                instance_id,
                tail=_optional_int(command.get("tail"), 200),
                previous=bool(command.get("previous")),
                order=str(command.get("order") or "desc"),
            )
            payload = {
                "request_id": str(command.get("request_id") or ""),
                "instance_id": instance_id,
                "generation": logs.get("generation"),
                "offset_start": logs.get("offset_start", 0),
                "offset_end": logs.get("offset_end", 0),
                "order": logs.get("order") or "desc",
                "lines": logs.get("lines") or [],
            }
            if post_log_chunk is not None:
                await post_log_chunk(payload)
                return {"status": "posted", "request_id": payload["request_id"]}
            return {"status": "log_chunk_ready", "chunk": payload}
        return {"status": "ignored", "reason": "unsupported_command"}

    def _handle_podium_human_answered(self, command: dict[str, Any]) -> dict[str, Any]:
        _ = command
        return {"status": "ignored", "reason": "managed_runs_use_runtime_wait_state"}
