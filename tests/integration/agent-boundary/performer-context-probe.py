from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from threading import Event
from typing import Any

from performer.agent_protocol.host import AgentProtocolHost
from performer.backends.provider_backend_interface import ProviderBackendError, ProviderSession


class ProbeBackend:
    def __init__(self, record_path: Path) -> None:
        self._record_path = record_path
        self._next_handle = 0

    def open_role_session(self, role: str, settings: dict[str, Any]) -> ProviderSession:
        self._next_handle += 1
        handle = f"{os.getpid()}:{role}:{self._next_handle}"
        self._write({"event": "opened", "pid": os.getpid(), "role": role, "handle": handle})
        return ProviderSession(role, handle, settings)

    def execute_role_turn(
        self,
        session: ProviderSession,
        request: dict[str, Any],
        *,
        workspace_root: Path | None,
        cancel_event: Event,
    ) -> dict[str, Any]:
        update = request.get("role_context_update")
        self._write({
            "event": "turn",
            "pid": os.getpid(),
            "role": session.role,
            "handle": session.provider_handle,
            "request_id": request.get("request_id"),
            "update": update,
        })
        bundle = request.get("instruction_bundle")
        if isinstance(bundle, dict) and bundle.get("instructions") == "force acceptance unknown":
            raise ProviderBackendError(
                "The probe could not prove Provider acceptance.",
                append_outcome="acceptance_unknown",
            )
        return {"output": {"kind": "canceled", "sanitized_reason": "probe cancellation"}}

    def interrupt_turn(self, session: ProviderSession) -> None:
        return None

    def close_role_session(self, session: ProviderSession) -> None:
        self._write({
            "event": "closed", "pid": os.getpid(), "role": session.role, "handle": session.provider_handle,
        })

    def _write(self, value: dict[str, Any]) -> None:
        with self._record_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(value, separators=(",", ":")) + "\n")


def main() -> None:
    record_path = Path(os.environ["SYMPHONY_CONTEXT_PROBE_RECORD"])
    host = AgentProtocolHost(ProbeBackend(record_path), workspace_root=Path.cwd())
    for result in host.iter_lines(sys.stdin.buffer, Event()):
        print(json.dumps(result, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
