from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from podium.models import RunStatus, RunSummary, RuntimeRecord
from podium.store import PodiumStore

# Enrollment tokens are short-lived; a real runtime installs and enrolls within
# minutes. Expired tokens no longer enroll a new runtime (see product doc).
ENROLLMENT_TOKEN_TTL = timedelta(hours=1)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


class RuntimeService:
    """
    Manages runtime (agent) enrollment, heartbeats, and run visibility.

    Responsibilities:
    - Generate enrollment tokens for new runtime installs
    - Track runtime online status via heartbeats
    - Provide UI-safe runtime listings and detail
    - Provide recent run summaries and run detail

    Enrollment tokens are single-use, short-lived secrets tracked per workspace.
    """

    def __init__(self, store: PodiumStore):
        self.store = store
        # enrollment token -> (workspace_id, expires_at)
        self._enrollment_tokens: dict[str, tuple[str, datetime]] = {}
        # run_id -> RunSummary
        self._runs: dict[str, RunSummary] = {}

    # ===== Enrollment =====

    def generate_enrollment_token(self, workspace_id: str) -> str:
        """
        Generate a new single-use, short-lived enrollment token for a workspace.

        Only one token is pending per workspace; generating a new one supersedes
        any previous unused token for that workspace.
        """
        # Drop any prior pending token for this workspace so it can't be reused.
        for existing in [t for t, (ws, _) in self._enrollment_tokens.items() if ws == workspace_id]:
            self._enrollment_tokens.pop(existing, None)
        token = secrets.token_urlsafe(32)
        self._enrollment_tokens[token] = (workspace_id, _now() + ENROLLMENT_TOKEN_TTL)
        return token

    def enrollment_token_expires_at(self, token: str) -> str | None:
        """ISO8601 expiry for a pending enrollment token, or None if unknown."""
        entry = self._enrollment_tokens.get(token)
        return _iso(entry[1]) if entry else None

    def enroll_runtime(
        self,
        enrollment_token: str,
        *,
        hostname: str | None = None,
        version: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> RuntimeRecord | None:
        """
        Consume a single-use enrollment token and register a runtime as online.

        A real runtime (Conductor) calls this after install with the one-time
        token. Returns the created RuntimeRecord, or None if the token was never
        issued, has expired, or was already used.
        """
        entry = self._enrollment_tokens.get(enrollment_token)
        if entry is None:
            return None
        workspace_id, expires_at = entry
        if expires_at < _now():
            # Expired: burn it so it can't enroll and report as unknown.
            self._enrollment_tokens.pop(enrollment_token, None)
            return None
        # Single-use: consume on success.
        self._enrollment_tokens.pop(enrollment_token, None)
        runtime_id = "rt-" + secrets.token_hex(8)
        record_metadata: dict[str, Any] = dict(metadata or {})
        record_metadata["workspace_id"] = workspace_id
        if hostname:
            record_metadata["hostname"] = hostname
        record = RuntimeRecord(
            runtime_id=runtime_id,
            online=True,
            last_heartbeat=_iso(_now()),
            version=version,
            metadata=record_metadata,
        )
        self.store.save_runtime_record(record)
        return record

    def enrollment_status(self, workspace_id: str) -> dict[str, Any]:
        """
        Report enrollment progress for a workspace.

        Returns UI-safe status: whether a token is pending and whether any
        runtime has come online.
        """
        runtimes = self.store.list_runtime_records()
        online = [r for r in runtimes if r.online]
        now = _now()
        pending = any(
            ws == workspace_id and expires_at >= now
            for ws, expires_at in self._enrollment_tokens.values()
        )
        return {
            "workspace_id": workspace_id,
            "token_pending": pending,
            "runtime_count": len(runtimes),
            "online_count": len(online),
            "enrolled": len(runtimes) > 0,
        }

    # ===== Runtimes =====

    def list_runtimes(self) -> list[RuntimeRecord]:
        """List all known runtimes with online status."""
        return self.store.list_runtime_records()

    def get_runtime(self, runtime_id: str) -> RuntimeRecord | None:
        """Get a single runtime record by ID."""
        return self.store.get_runtime_record(runtime_id)

    def record_heartbeat(self, runtime_id: str) -> None:
        """Record a heartbeat for a runtime, marking it online (auto-creates)."""
        self.store.update_runtime_heartbeat(runtime_id)

    def heartbeat(
        self,
        runtime_id: str,
        *,
        version: str | None = None,
        status: str | None = None,
    ) -> RuntimeRecord | None:
        """
        Record a heartbeat for an already-enrolled runtime.

        Updates last_heartbeat and keeps the runtime online. Returns the updated
        record, or None if the runtime is unknown (never enrolled).
        """
        record = self.store.get_runtime_record(runtime_id)
        if record is None:
            return None
        online = status != "offline"
        return self.store.record_runtime_heartbeat(
            runtime_id,
            version=version,
            online=online,
        )

    # ===== Runs =====

    def record_run(self, summary: RunSummary) -> None:
        """Store a run summary."""
        self._runs[summary.run_id] = summary

    def recent_runs(self, limit: int = 10) -> list[RunSummary]:
        """
        Return the most recent N runs, newest first.

        Runs are sorted by started_at descending (None sorts last).
        """
        runs = list(self._runs.values())
        runs.sort(key=lambda r: r.started_at or "", reverse=True)
        return runs[:limit]

    def get_run(self, run_id: str) -> RunSummary | None:
        """Get a single run summary by ID."""
        return self._runs.get(run_id)
