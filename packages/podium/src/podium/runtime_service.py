from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Any

from .models import RunSummary, RuntimeRecord
from .store import PodiumStore


class RuntimeService:
    def __init__(self, store: PodiumStore) -> None:
        self.store = store
        self.pending_tokens: dict[str, str] = {}

    def generate_enrollment_token(self, workspace_id: str) -> str:
        token = secrets.token_urlsafe(32)
        self.pending_tokens[token] = workspace_id
        return token

    def consume_enrollment_token(self, token: str) -> str | None:
        return self.pending_tokens.pop(token, None)

    def enrollment_status(self, workspace_id: str) -> dict[str, Any]:
        records = self.store.list_runtime_records()
        online = [record for record in records if record.online]
        return {
            "workspace_id": workspace_id,
            "token_pending": workspace_id in self.pending_tokens.values(),
            "runtime_count": len(records),
            "online_count": len(online),
            "enrolled": len(records) > 0,
        }

    def list_runtimes(self) -> list[RuntimeRecord]:
        return self.store.list_runtime_records()

    def get_runtime(self, runtime_id: str) -> RuntimeRecord | None:
        return self.store.get_runtime_record(runtime_id)

    def record_heartbeat(
        self,
        runtime_id: str,
        *,
        version: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> RuntimeRecord:
        return self.store.update_runtime_heartbeat(
            runtime_id,
            version=version,
            metadata=metadata,
            timestamp=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        )

    def record_run(self, run: RunSummary) -> None:
        self.store.save_run(run)

    def recent_runs(self, limit: int = 10) -> list[RunSummary]:
        runs = sorted(
            self.store.list_runs(),
            key=lambda run: run.started_at or "",
            reverse=True,
        )
        return runs[:limit]

    def get_run(self, run_id: str) -> RunSummary | None:
        return self.store.get_run(run_id)
