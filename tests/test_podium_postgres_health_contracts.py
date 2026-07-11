from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from podium.app import _dispatch_lease_reaper_loop, create_app
from podium.store import PgStore


class ReaperState:
    def __init__(self, store: Any, *, failing: bool) -> None:
        self.store = store
        self.failing = failing

    async def reap_expired_dispatch_leases(self) -> int:
        if self.failing:
            raise RuntimeError("password=database-secret")
        return 1


class PausingClearStore:
    def __init__(self, store: PgStore) -> None:
        self.store = store
        self.clear_started = asyncio.Event()
        self.release_clear = asyncio.Event()

    async def get_background_job_failure(self, job_name: str) -> dict[str, Any] | None:
        return await self.store.get_background_job_failure(job_name)

    async def clear_background_job_failure(
        self,
        job_name: str,
        failure_id: str,
    ) -> dict[str, Any] | None:
        self.clear_started.set()
        await self.release_clear.wait()
        return await self.store.clear_background_job_failure(job_name, failure_id)


async def _run_reaper_once(app: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    async def stop_after_attempt(_seconds: float) -> None:
        raise asyncio.CancelledError

    monkeypatch.setattr("podium.app.asyncio.sleep", stop_after_attempt)
    with pytest.raises(asyncio.CancelledError):
        await _dispatch_lease_reaper_loop(app)


async def _health(app: Any) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://podium.test",
    ) as client:
        return await client.get("/api/v1/health")


@pytest.mark.asyncio
async def test_pg_reaper_health_is_atomic_shared_across_workers_and_restart_safe(
    postgres_database_url: str,
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_store = await PgStore.connect(postgres_database_url)
    second_store = await PgStore.connect(postgres_database_url)
    restarted_store = await PgStore.connect(postgres_database_url)
    try:
        await first_store.migrate()
        first = create_app(store=first_store, secret_key="test-secret", secure_cookies=False)
        second = create_app(store=second_store, secret_key="test-secret", secure_cookies=False)
        caplog.set_level("INFO", logger="podium.app")
        first.state.podium = ReaperState(first_store, failing=True)
        second.state.podium = ReaperState(second_store, failing=True)

        await asyncio.gather(
            _run_reaper_once(first, monkeypatch),
            _run_reaper_once(second, monkeypatch),
        )

        persisted = await first_store.get_background_job_failure("dispatch_lease_reaper")
        first_health = await _health(first)
        second_health = await _health(second)
        restarted = create_app(
            store=restarted_store,
            secret_key="test-secret",
            secure_cookies=False,
        )
        restarted_health = await _health(restarted)

        assert persisted is not None and persisted["attempt_number"] == 2
        assert first_health.status_code == second_health.status_code == restarted_health.status_code == 503
        assert first_health.json() == second_health.json() == restarted_health.json()
        assert "database-secret" not in json.dumps(persisted)
        assert "database-secret" not in restarted_health.text

        paused_store = PausingClearStore(second_store)
        second.state.podium = ReaperState(paused_store, failing=False)
        stale_success = asyncio.create_task(_run_reaper_once(second, monkeypatch))
        await asyncio.wait_for(paused_store.clear_started.wait(), timeout=2)
        await _run_reaper_once(first, monkeypatch)
        newer_failure = await first_store.get_background_job_failure("dispatch_lease_reaper")
        paused_store.release_clear.set()
        await stale_success

        assert newer_failure is not None
        assert newer_failure["failure_id"] != persisted["failure_id"]
        assert await first_store.get_background_job_failure("dispatch_lease_reaper") == newer_failure
        assert (await _health(first)).status_code == 503
        assert (await _health(second)).status_code == 503
        assert (await _health(restarted)).status_code == 503
        assert "podium_dispatch_reaper_recovered" not in caplog.text

        second.state.podium = ReaperState(second_store, failing=False)
        await _run_reaper_once(second, monkeypatch)

        assert await first_store.get_background_job_failure("dispatch_lease_reaper") is None
        assert (await _health(first)).json() == {"status": "ok"}
        assert (await _health(restarted)).json() == {"status": "ok"}

        failure = {
            "error_type": "RuntimeError",
            "error_code": "dispatch_reaper_failed",
            "sanitized_reason": "Dispatch lease cleanup failed",
            "action_required": "restore_podium_database",
            "retryable": True,
            "next_action": "retry_dispatch_lease_reap",
        }
        first_incident = await first_store.record_background_job_failure(
            "dispatch_lease_reaper",
            failure,
        )
        await first_store.clear_background_job_failure(
            "dispatch_lease_reaper",
            first_incident["failure_id"],
        )
        second_incident = await second_store.record_background_job_failure(
            "dispatch_lease_reaper",
            failure,
        )
        stale_aba_clear = await first_store.clear_background_job_failure(
            "dispatch_lease_reaper",
            first_incident["failure_id"],
        )

        assert first_incident["attempt_number"] == second_incident["attempt_number"] == 1
        assert first_incident["failure_id"] != second_incident["failure_id"]
        assert stale_aba_clear is None
        assert await first_store.get_background_job_failure("dispatch_lease_reaper") == second_incident
        await first_store.clear_background_job_failure(
            "dispatch_lease_reaper",
            second_incident["failure_id"],
        )
        polling_incident = await first_store.record_background_job_failure(
            "linear_reconciliation",
            {
                "error_type": "RuntimeError",
                "error_code": "linear_reconciliation_loop_failed",
                "sanitized_reason": "Linear delegated-issue polling failed",
                "action_required": "inspect_podium_linear_polling",
                "retryable": True,
                "next_action": "retry_linear_reconciliation",
            },
        )
        polling_health = await _health(restarted)
        assert polling_health.status_code == 503
        assert polling_health.json()["error"]["error_code"] == (
            "linear_reconciliation_loop_failed"
        )
        await second_store.clear_background_job_failure(
            "linear_reconciliation",
            polling_incident["failure_id"],
        )
        assert (await _health(restarted)).json() == {"status": "ok"}
        probe_rows = await first_store.pool.fetchval(
            "SELECT count(*) FROM background_job_failures WHERE job_name LIKE '__health_probe__:%'"
        )
        assert probe_rows == 0
    finally:
        await first_store.close()
        await second_store.close()
        await restarted_store.close()


@pytest.mark.asyncio
async def test_pg_health_migration_backfills_legacy_failure_fence_and_allows_recovery(
    postgres_database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = await PgStore.connect(postgres_database_url)
    try:
        await store.pool.execute(
            """
            CREATE TABLE background_job_failures (
              job_name TEXT PRIMARY KEY,
              error_type TEXT NOT NULL,
              error_code TEXT NOT NULL,
              sanitized_reason TEXT NOT NULL,
              action_required TEXT NOT NULL,
              retryable BOOLEAN NOT NULL,
              attempt_number BIGINT NOT NULL,
              next_action TEXT NOT NULL,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
        await store.pool.execute(
            """
            INSERT INTO background_job_failures (
              job_name, error_type, error_code, sanitized_reason, action_required,
              retryable, attempt_number, next_action
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            """,
            "dispatch_lease_reaper",
            "RuntimeError",
            "dispatch_reaper_failed",
            "Dispatch lease cleanup failed",
            "restore_podium_database",
            True,
            4,
            "retry_dispatch_lease_reap",
        )

        await store.migrate()

        migrated = await store.get_background_job_failure("dispatch_lease_reaper")
        column = await store.pool.fetchrow(
            """
            SELECT is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'background_job_failures'
              AND column_name = 'failure_id'
            """
        )
        app = create_app(store=store, secret_key="test-secret", secure_cookies=False)
        app.state.podium = ReaperState(store, failing=False)
        await _run_reaper_once(app, monkeypatch)

        assert migrated is not None
        assert migrated["attempt_number"] == 4
        assert migrated["failure_id"]
        assert column is not None and dict(column) == {
            "is_nullable": "NO",
            "column_default": None,
        }
        assert await store.get_background_job_failure("dispatch_lease_reaper") is None
        assert (await _health(app)).json() == {"status": "ok"}
    finally:
        await store.close()
