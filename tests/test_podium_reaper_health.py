from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from podium.app import (
    _dispatch_lease_reaper_loop,
    _start_linear_reconciliation,
    create_app,
)
from podium.linear_reconciliation import run_linear_reconciliation_loop
from podium.podium_health import (
    clear_background_job_failure,
    record_background_job_failure,
)


JOB_NAME = "dispatch_lease_reaper"


class ReaperHealthStore:
    def __init__(self, *, reap_error: Exception | None = None) -> None:
        self.reap_error = reap_error
        self.failures: dict[str, dict[str, Any]] = {}
        self.failure_sequence = 0
        self.failure_recorded = asyncio.Event()
        self.failure_cleared = asyncio.Event()

    @property
    def failure(self) -> dict[str, Any] | None:
        return self.failures.get(JOB_NAME)

    @failure.setter
    def failure(self, value: dict[str, Any] | None) -> None:
        if value is None:
            self.failures.pop(JOB_NAME, None)
        else:
            self.failures[JOB_NAME] = value

    async def reap_expired_dispatch_leases(self) -> int:
        if self.reap_error is not None:
            raise self.reap_error
        return 1

    async def record_background_job_failure(
        self,
        job_name: str,
        failure: dict[str, Any],
    ) -> dict[str, Any]:
        attempt_number = int((self.failures.get(job_name) or {}).get("attempt_number") or 0) + 1
        self.failure_sequence += 1
        recorded = {
            **failure,
            "attempt_number": attempt_number,
            "failure_id": f"failure-{self.failure_sequence}",
        }
        self.failures[job_name] = recorded
        self.failure_recorded.set()
        return dict(recorded)

    async def get_background_job_failure(self, job_name: str) -> dict[str, Any] | None:
        failure = self.failures.get(job_name)
        return dict(failure) if failure is not None else None

    async def probe_background_job_failure_store(self) -> None:
        return None

    async def clear_background_job_failure(
        self,
        job_name: str,
        failure_id: str,
    ) -> dict[str, Any] | None:
        failure = self.failures.get(job_name)
        if failure is None or failure["failure_id"] != failure_id:
            return None
        previous = self.failures.pop(job_name)
        self.failure_cleared.set()
        return dict(previous)


class UnavailableHealthStore(ReaperHealthStore):
    async def get_background_job_failure(self, job_name: str) -> dict[str, Any] | None:
        raise RuntimeError("password=health-store-secret")


class WriteDeniedHealthStore(ReaperHealthStore):
    async def record_background_job_failure(
        self,
        job_name: str,
        failure: dict[str, Any],
    ) -> dict[str, Any]:
        raise RuntimeError("password=write-denied-secret")

    async def probe_background_job_failure_store(self) -> None:
        raise RuntimeError("password=write-denied-secret")


class WriteOnlyDeniedHealthStore(ReaperHealthStore):
    async def record_background_job_failure(
        self,
        job_name: str,
        failure: dict[str, Any],
    ) -> dict[str, Any]:
        raise RuntimeError("password=write-only-denied-secret")


class RecoveringWriteHealthStore(ReaperHealthStore):
    def __init__(self) -> None:
        super().__init__()
        self.writes_allowed = False

    async def record_background_job_failure(
        self,
        job_name: str,
        failure: dict[str, Any],
    ) -> dict[str, Any]:
        if not self.writes_allowed:
            raise RuntimeError("password=transient-write-secret")
        return await super().record_background_job_failure(job_name, failure)


class PausingClearStore(ReaperHealthStore):
    def __init__(self, *, reap_error: Exception | None = None) -> None:
        super().__init__(reap_error=reap_error)
        self.clear_started = asyncio.Event()
        self.release_clear = asyncio.Event()

    async def clear_background_job_failure(
        self,
        job_name: str,
        failure_id: str,
    ) -> dict[str, Any] | None:
        self.clear_started.set()
        await self.release_clear.wait()
        return await super().clear_background_job_failure(job_name, failure_id)


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


class RecoveringReconciler:
    def __init__(self, store: ReaperHealthStore) -> None:
        self.state = SimpleNamespace(store=store)
        self.attempts = 0
        self.recovered = asyncio.Event()
        self.hold_after_recovery = asyncio.Event()

    async def reconcile_once(self) -> dict[str, int]:
        self.attempts += 1
        if self.attempts == 1:
            raise RuntimeError("token=linear-polling-secret")
        if self.attempts == 2:
            self.recovered.set()
            return {"installations": 0, "bindings": 0, "queued": 0, "errors": 0}
        await self.hold_after_recovery.wait()
        return {"installations": 0, "bindings": 0, "queued": 0, "errors": 0}


class ReportedErrorReconciler:
    def __init__(self, store: ReaperHealthStore) -> None:
        self.state = SimpleNamespace(store=store)

    async def reconcile_once(self) -> dict[str, int]:
        return {"installations": 1, "bindings": 1, "queued": 0, "errors": 1}


class NeverReturningReconciler:
    def __init__(self, store: ReaperHealthStore) -> None:
        self.state = SimpleNamespace(store=store)
        self.cancelled = asyncio.Event()

    async def reconcile_once(self) -> dict[str, int]:
        try:
            await asyncio.Event().wait()
        finally:
            self.cancelled.set()


class FailingHealthCapabilitiesStore(ReaperHealthStore):
    def __init__(self) -> None:
        super().__init__()
        self.health_reader_lookups = 0
        self.failures["linear_reconciliation"] = {
            "failure_id": "polling-failure",
            "error_type": "RuntimeError",
            "error_code": "linear_reconciliation_loop_failed",
            "sanitized_reason": "Linear delegated-issue polling failed",
            "action_required": "inspect_podium_linear_polling",
            "retryable": True,
            "attempt_number": 1,
            "next_action": "retry_linear_reconciliation",
        }

    @property
    def get_background_job_failure(self) -> Any:
        self.health_reader_lookups += 1
        if self.health_reader_lookups == 1:
            raise RuntimeError("password=health-read-secret")

        async def load(job_name: str) -> dict[str, Any] | None:
            failure = self.failures.get(job_name)
            return dict(failure) if failure is not None else None

        return load

    @property
    def record_background_job_failure(self) -> Any:
        raise RuntimeError("password=health-write-secret")

    @property
    def clear_background_job_failure(self) -> Any:
        raise RuntimeError("password=health-clear-secret")


@pytest.mark.asyncio
async def test_linear_polling_loop_records_failure_retries_and_preserves_cancellation(
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = ReaperHealthStore()
    app = create_app(store=store, secret_key="test-secret", secure_cookies=False)
    reconciler = RecoveringReconciler(store)
    retry = asyncio.Event()

    async def controlled_sleep(_seconds: float) -> None:
        await retry.wait()

    monkeypatch.setattr(
        "podium.linear_reconciliation_supervisor.asyncio.sleep",
        controlled_sleep,
    )
    caplog.set_level("INFO", logger="podium.app")
    task = asyncio.create_task(
        run_linear_reconciliation_loop(reconciler, interval_seconds=1)
    )
    await asyncio.wait_for(store.failure_recorded.wait(), timeout=2)

    failed_health = await _health(app)
    assert not task.done()
    assert failed_health.status_code == 503
    assert failed_health.json()["error"] == {
        "action_required": "inspect_podium_linear_polling",
        "attempt_number": 1,
        "error_code": "linear_reconciliation_loop_failed",
        "error_type": "RuntimeError",
        "next_action": "retry_linear_reconciliation",
        "retryable": True,
        "sanitized_reason": "Linear delegated-issue polling failed",
    }

    retry.set()
    await asyncio.wait_for(reconciler.recovered.wait(), timeout=2)
    await asyncio.wait_for(store.failure_cleared.wait(), timeout=2)
    assert (await _health(app)).json() == {"status": "ok"}

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    failure_log = next(
        json.loads(record.getMessage())
        for record in caplog.records
        if "podium_linear_reconciliation_loop_failed" in record.getMessage()
    )
    assert failure_log == {
        "event": "podium_linear_reconciliation_loop_failed",
        **failed_health.json()["error"],
    }
    assert "podium_linear_reconciliation_loop_recovered" in caplog.text
    assert "linear-polling-secret" not in caplog.text
    assert "linear-polling-secret" not in failed_health.text


@pytest.mark.asyncio
async def test_linear_polling_supervisor_survives_health_capability_failures(
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = FailingHealthCapabilitiesStore()
    reconciler = RecoveringReconciler(store)
    release_retry = asyncio.Event()
    second_sleep = asyncio.Event()
    sleep_calls = 0

    async def controlled_sleep(_seconds: float) -> None:
        nonlocal sleep_calls
        sleep_calls += 1
        if sleep_calls == 1:
            await release_retry.wait()
        else:
            second_sleep.set()
            await asyncio.Event().wait()

    monkeypatch.setattr(
        "podium.linear_reconciliation_supervisor.asyncio.sleep",
        controlled_sleep,
    )
    caplog.set_level("INFO", logger="podium.app")
    task = asyncio.create_task(
        run_linear_reconciliation_loop(reconciler, interval_seconds=1)
    )
    release_retry.set()
    await asyncio.wait_for(second_sleep.wait(), timeout=2)

    assert reconciler.attempts == 2
    assert not task.done()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert caplog.text.count("podium_background_health_store_unavailable") >= 3
    assert "password=" not in caplog.text


@pytest.mark.asyncio
async def test_linear_polling_reported_errors_do_not_clear_current_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = ReaperHealthStore()
    previous = await store.record_background_job_failure(
        "linear_reconciliation",
        {
            "error_type": "LinearReconciliationCycleError",
            "error_code": "linear_reconciliation_loop_failed",
            "sanitized_reason": "Linear delegated-issue polling failed",
            "action_required": "inspect_podium_linear_polling",
            "retryable": True,
            "attempt_number": 1,
            "next_action": "retry_linear_reconciliation",
        },
    )

    async def stop_after_attempt(_seconds: float) -> None:
        raise asyncio.CancelledError

    monkeypatch.setattr(
        "podium.linear_reconciliation_supervisor.asyncio.sleep",
        stop_after_attempt,
    )
    with pytest.raises(asyncio.CancelledError):
        await run_linear_reconciliation_loop(
            ReportedErrorReconciler(store),
            interval_seconds=1,
        )

    current = await store.get_background_job_failure("linear_reconciliation")
    assert current is not None
    assert current["failure_id"] != previous["failure_id"]
    assert current["attempt_number"] == 2
    assert not store.failure_cleared.is_set()


@pytest.mark.asyncio
async def test_linear_polling_timeout_cancels_stuck_cycle_and_degrades_health(
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = ReaperHealthStore()
    app = create_app(store=store, secret_key="test-secret", secure_cookies=False)
    reconciler = NeverReturningReconciler(store)

    async def stop_after_attempt(_seconds: float) -> None:
        raise asyncio.CancelledError

    monkeypatch.setattr(
        "podium.linear_reconciliation_supervisor.asyncio.sleep",
        stop_after_attempt,
    )
    caplog.set_level("INFO", logger="podium.app")
    with pytest.raises(asyncio.CancelledError):
        await run_linear_reconciliation_loop(
            reconciler,
            interval_seconds=1,
            cycle_timeout_seconds=0.01,
        )

    health = await _health(app)
    assert reconciler.cancelled.is_set()
    assert health.status_code == 503
    assert health.json()["error"]["error_type"] == "TimeoutError"
    assert "podium_linear_reconciliation_loop_failed" in caplog.text


@pytest.mark.asyncio
async def test_linear_polling_startup_is_degraded_before_background_task_runs() -> None:
    store = ReaperHealthStore()
    app = create_app(store=store, secret_key="test-secret", secure_cookies=False)
    blocked = asyncio.Event()

    async def list_active_installations() -> list[dict[str, Any]]:
        await blocked.wait()
        return []

    app.state.podium.list_active_linear_installations = list_active_installations
    task = _start_linear_reconciliation(
        app.state.podium,
        linear_graphql_transport=None,
    )
    try:
        health = await _health(app)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert health.status_code == 503
    assert health.json()["error"]["error_code"] == "linear_reconciliation_not_ready"


@pytest.mark.asyncio
async def test_reaper_failure_log_is_structured_complete_and_sanitized(
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = ReaperHealthStore(
        reap_error=RuntimeError("password=database-secret"),
    )
    app = create_app(store=store, secret_key="test-secret", secure_cookies=False)
    caplog.set_level("INFO", logger="podium.app")

    await _run_reaper_once(app, monkeypatch)

    record = next(
        record
        for record in caplog.records
        if "podium_dispatch_reaper_failed" in record.getMessage()
    )
    payload = json.loads(record.getMessage())
    assert payload == {
        "action_required": "restore_podium_database",
        "attempt_number": 1,
        "error_code": "dispatch_reaper_failed",
        "error_type": "RuntimeError",
        "event": "podium_dispatch_reaper_failed",
        "next_action": "retry_dispatch_lease_reap",
        "retryable": True,
        "sanitized_reason": "Dispatch lease cleanup failed",
    }
    assert "database-secret" not in record.getMessage()
    assert "database-secret" not in json.dumps(store.failure)


@pytest.mark.asyncio
async def test_reaper_failure_and_recovery_are_shared_across_app_instances(
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = ReaperHealthStore(reap_error=RuntimeError("token=must-not-leak"))
    first = create_app(store=store, secret_key="test-secret", secure_cookies=False)
    second = create_app(store=store, secret_key="test-secret", secure_cookies=False)
    caplog.set_level("INFO", logger="podium.app")

    await _run_reaper_once(first, monkeypatch)

    first_health = await _health(first)
    second_health = await _health(second)
    assert first_health.status_code == second_health.status_code == 503
    assert first_health.json() == second_health.json()
    assert first_health.json()["error"]["attempt_number"] == 1
    assert "must-not-leak" not in first_health.text

    store.reap_error = None
    await _run_reaper_once(second, monkeypatch)

    assert (await _health(first)).json() == {"status": "ok"}
    assert (await _health(second)).json() == {"status": "ok"}
    recovery = next(
        json.loads(record.getMessage())
        for record in caplog.records
        if "podium_dispatch_reaper_recovered" in record.getMessage()
    )
    assert recovery["attempt_number"] == 1
    assert recovery["event"] == "podium_dispatch_reaper_recovered"


@pytest.mark.asyncio
async def test_stale_success_cannot_clear_a_newer_worker_failure(
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = PausingClearStore(reap_error=RuntimeError("initial failure"))
    first = create_app(store=store, secret_key="test-secret", secure_cookies=False)
    second = create_app(store=store, secret_key="test-secret", secure_cookies=False)
    caplog.set_level("INFO", logger="podium.app")
    await _run_reaper_once(first, monkeypatch)
    initial_failure_id = str((store.failure or {})["failure_id"])

    store.reap_error = None
    stale_success = asyncio.create_task(_run_reaper_once(first, monkeypatch))
    await asyncio.wait_for(store.clear_started.wait(), timeout=2)
    store.reap_error = RuntimeError("newer failure")
    await _run_reaper_once(second, monkeypatch)
    newer_failure = dict(store.failure or {})
    store.release_clear.set()
    await stale_success

    assert newer_failure["failure_id"] != initial_failure_id
    assert store.failure == newer_failure
    assert (await _health(first)).status_code == 503
    assert (await _health(second)).status_code == 503
    assert "podium_dispatch_reaper_recovered" not in caplog.text


@pytest.mark.asyncio
async def test_health_fails_closed_with_fixed_sanitized_error_when_store_is_unavailable(
    caplog: pytest.LogCaptureFixture,
) -> None:
    app = create_app(
        store=UnavailableHealthStore(),
        secret_key="test-secret",
        secure_cookies=False,
    )
    missing_capability = create_app(
        store=object(),
        secret_key="test-secret",
        secure_cookies=False,
    )
    caplog.set_level("INFO", logger="podium.app")

    health = await _health(app)
    missing_capability_health = await _health(missing_capability)

    expected = {
        "status": "degraded",
        "error": {
            "error_type": "HealthStoreUnavailable",
            "error_code": "background_health_store_unavailable",
            "sanitized_reason": "Background health state is unavailable",
            "action_required": "restore_podium_database",
            "retryable": True,
            "attempt_number": 1,
            "next_action": "retry_health_check",
        },
    }
    assert health.status_code == missing_capability_health.status_code == 503
    assert health.json() == missing_capability_health.json() == expected
    events = [
        json.loads(record.getMessage())
        for record in caplog.records
        if "podium_background_health_store_unavailable" in record.getMessage()
    ]
    assert events == [
        {"event": "podium_background_health_store_unavailable", **expected["error"]},
        {"event": "podium_background_health_store_unavailable", **expected["error"]},
    ]
    assert "health-store-secret" not in health.text
    assert "health-store-secret" not in caplog.text


@pytest.mark.asyncio
async def test_record_failure_with_readable_but_write_denied_store_fails_closed_for_all_apps(
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = WriteDeniedHealthStore(
        reap_error=RuntimeError("password=reaper-secret"),
    )
    first = create_app(store=store, secret_key="test-secret", secure_cookies=False)
    second = create_app(store=store, secret_key="test-secret", secure_cookies=False)
    caplog.set_level("INFO", logger="podium.app")

    await _run_reaper_once(first, monkeypatch)
    first_health = await _health(first)
    second_health = await _health(second)

    assert first_health.status_code == second_health.status_code == 503
    assert first_health.json() == second_health.json()
    assert first_health.json()["error"]["error_code"] == "background_health_store_unavailable"
    assert "reaper-secret" not in caplog.text
    assert "write-denied-secret" not in caplog.text
    assert "write-denied-secret" not in first_health.text


@pytest.mark.asyncio
async def test_failure_write_error_stays_degraded_even_when_health_probe_succeeds(
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = WriteOnlyDeniedHealthStore(
        reap_error=RuntimeError("password=reaper-secret"),
    )
    app = create_app(store=store, secret_key="test-secret", secure_cookies=False)
    caplog.set_level("INFO", logger="podium.app")

    await _run_reaper_once(app, monkeypatch)
    health = await _health(app)

    assert health.status_code == 503
    assert health.json()["error"]["error_code"] == "background_health_store_unavailable"
    assert "reaper-secret" not in caplog.text
    assert "write-only-denied-secret" not in caplog.text
    assert "write-only-denied-secret" not in health.text


@pytest.mark.asyncio
async def test_transient_failure_write_is_persisted_before_success_can_recover_health() -> None:
    store = RecoveringWriteHealthStore()
    app = create_app(store=store, secret_key="test-secret", secure_cookies=False)
    failure = {
        "error_type": "RuntimeError",
        "error_code": "linear_reconciliation_loop_failed",
        "sanitized_reason": "Linear delegated-issue polling failed",
        "action_required": "inspect_podium_linear_polling",
        "retryable": True,
        "attempt_number": 1,
        "next_action": "retry_linear_reconciliation",
    }

    await record_background_job_failure(
        store,
        "linear_reconciliation",
        failure,
        event="podium_linear_reconciliation_loop_failed",
    )
    assert (await _health(app)).status_code == 503

    store.writes_allowed = True
    await clear_background_job_failure(
        store,
        "linear_reconciliation",
        None,
        event="podium_linear_reconciliation_loop_recovered",
    )
    persisted = await store.get_background_job_failure("linear_reconciliation")
    still_degraded = await _health(app)

    assert persisted is not None
    assert still_degraded.status_code == 503
    assert still_degraded.json()["error"]["error_code"] == (
        "background_health_store_unavailable"
    )

    await clear_background_job_failure(
        store,
        "linear_reconciliation",
        persisted,
        event="podium_linear_reconciliation_loop_recovered",
    )
    assert (await _health(app)).json() == {"status": "ok"}
