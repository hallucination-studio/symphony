from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .models import RuntimeRecord
from .store import PodiumStore


class RuntimeService:
    def __init__(self, store: PodiumStore) -> None:
        self.store = store

    def enrollment_status(self, workspace_id: str, *, token_pending: bool = False) -> dict[str, Any]:
        records = self.store.list_runtime_records()
        online = [record for record in records if record.online]
        return {
            "workspace_id": workspace_id,
            "token_pending": token_pending,
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
