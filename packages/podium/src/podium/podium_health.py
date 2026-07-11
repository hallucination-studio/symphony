from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse


DISPATCH_REAPER_JOB = "dispatch_lease_reaper"
LINEAR_RECONCILIATION_JOB = "linear_reconciliation"
BACKGROUND_JOBS = (DISPATCH_REAPER_JOB, LINEAR_RECONCILIATION_JOB)
LOGGER = logging.getLogger("podium.app")
PUBLIC_FAILURE_FIELDS = (
    "error_type",
    "error_code",
    "sanitized_reason",
    "action_required",
    "retryable",
    "attempt_number",
    "next_action",
)
LOCAL_FAILURES_ATTRIBUTE = "_podium_background_health_failures"
LOCAL_FAILURE_SOURCE = "_local_failure_source"
STARTUP_FAILURE_SOURCE = "startup"
PERSISTENCE_FAILURE_SOURCE = "persistence"


def _dispatch_reaper_failure(error_type: str, *, attempt_number: int = 1) -> dict[str, Any]:
    return {
        "error_type": error_type,
        "error_code": "dispatch_reaper_failed",
        "sanitized_reason": "Dispatch lease cleanup failed",
        "action_required": "restore_podium_database",
        "retryable": True,
        "attempt_number": attempt_number,
        "next_action": "retry_dispatch_lease_reap",
    }


def linear_reconciliation_loop_failure(
    error_type: str,
    *,
    attempt_number: int = 1,
) -> dict[str, Any]:
    return {
        "error_type": error_type,
        "error_code": "linear_reconciliation_loop_failed",
        "sanitized_reason": "Linear delegated-issue polling failed",
        "action_required": "inspect_podium_linear_polling",
        "retryable": True,
        "attempt_number": attempt_number,
        "next_action": "retry_linear_reconciliation",
    }


def linear_reconciliation_starting_failure() -> dict[str, Any]:
    return {
        "error_type": "LinearReconciliationStarting",
        "error_code": "linear_reconciliation_not_ready",
        "sanitized_reason": "Linear delegated-issue polling has not completed a cycle",
        "action_required": "wait_for_linear_reconciliation",
        "retryable": True,
        "attempt_number": 1,
        "next_action": "complete_linear_reconciliation_cycle",
    }


def mark_linear_reconciliation_starting(store: Any) -> None:
    _record_local_background_job_failure(
        store,
        LINEAR_RECONCILIATION_JOB,
        failure=linear_reconciliation_starting_failure(),
        source=STARTUP_FAILURE_SOURCE,
    )


def _health_store_unavailable() -> dict[str, Any]:
    return {
        "error_type": "HealthStoreUnavailable",
        "error_code": "background_health_store_unavailable",
        "sanitized_reason": "Background health state is unavailable",
        "action_required": "restore_podium_database",
        "retryable": True,
        "attempt_number": 1,
        "next_action": "retry_health_check",
    }


def _log(level: int, event: str, fields: dict[str, Any]) -> None:
    LOGGER.log(
        level,
        json.dumps(
            {"event": event, **_public_failure(fields)},
            separators=(",", ":"),
            sort_keys=True,
        ),
    )


def _log_health_store_unavailable() -> None:
    _log(
        logging.WARNING,
        "podium_background_health_store_unavailable",
        _health_store_unavailable(),
    )


async def health_response(store: Any) -> JSONResponse:
    try:
        probe_store = getattr(store, "probe_background_job_failure_store", None)
        load_failure = getattr(store, "get_background_job_failure", None)
        if probe_store is None or load_failure is None:
            raise AttributeError("background health store is unavailable")
        await probe_store()
        failure = None
        for job_name in BACKGROUND_JOBS:
            failure = await load_failure(job_name)
            if isinstance(failure, dict):
                break
        if failure is None:
            failure = _local_background_job_failure(store)
    except Exception:
        failure = _health_store_unavailable()
        _log_health_store_unavailable()
    if isinstance(failure, dict):
        return JSONResponse(
            {"status": "degraded", "error": _public_failure(failure)},
            status_code=503,
        )
    return JSONResponse({"status": "ok"})


async def dispatch_lease_reaper_loop(app: FastAPI) -> None:
    while True:
        state = app.state.podium
        store = getattr(state, "store", None)
        observed_failure = await load_background_job_failure(store, DISPATCH_REAPER_JOB)
        try:
            await state.reap_expired_dispatch_leases()
        except Exception as exc:
            await record_background_job_failure(
                store,
                DISPATCH_REAPER_JOB,
                _dispatch_reaper_failure(type(exc).__name__),
                event="podium_dispatch_reaper_failed",
            )
        else:
            await clear_background_job_failure(
                store,
                DISPATCH_REAPER_JOB,
                observed_failure,
                event="podium_dispatch_reaper_recovered",
            )
        await asyncio.sleep(30)


async def record_background_job_failure(
    store: Any,
    job_name: str,
    failure: dict[str, Any],
    *,
    event: str,
) -> None:
    try:
        save_failure = getattr(store, "record_background_job_failure", None)
        if save_failure is None:
            raise AttributeError("background health writer is unavailable")
        persisted = await save_failure(job_name, failure)
        if not isinstance(persisted, dict):
            raise RuntimeError("background health writer did not confirm persistence")
        failure = {**failure, **persisted}
        _clear_local_background_job_failure(store, job_name)
    except Exception:
        _record_local_background_job_failure(store, job_name)
        _log_health_store_unavailable()
    _log(logging.WARNING, event, failure)


async def load_background_job_failure(
    store: Any,
    job_name: str,
) -> dict[str, Any] | None:
    try:
        load_failure = getattr(store, "get_background_job_failure", None)
        if load_failure is None:
            raise AttributeError("background health reader is unavailable")
        failure = await load_failure(job_name)
    except Exception:
        _record_local_background_job_failure(store, job_name)
        _log_health_store_unavailable()
        return None
    return failure if isinstance(failure, dict) else None


async def clear_background_job_failure(
    store: Any,
    job_name: str,
    observed_failure: dict[str, Any] | None,
    *,
    event: str,
) -> None:
    failure_id = str((observed_failure or {}).get("failure_id") or "")
    if not failure_id:
        local_failure = _local_background_job_failure(store, job_name)
        if local_failure is None:
            return
        try:
            if local_failure.get(LOCAL_FAILURE_SOURCE) == PERSISTENCE_FAILURE_SOURCE:
                save_failure = getattr(store, "record_background_job_failure", None)
                if save_failure is None:
                    raise AttributeError("background health recovery writer is unavailable")
                persisted = await save_failure(job_name, local_failure)
                if not isinstance(persisted, dict):
                    raise RuntimeError("background health recovery was not persisted")
                _clear_local_background_job_failure(store, job_name)
                _log(
                    logging.WARNING,
                    "podium_background_health_failure_persisted",
                    {**local_failure, **persisted},
                )
                return
            probe_store = getattr(store, "probe_background_job_failure_store", None)
            if probe_store is None:
                raise AttributeError("background health recovery probe is unavailable")
            await probe_store()
        except Exception:
            _log_health_store_unavailable()
            return
        _clear_local_background_job_failure(store, job_name)
        _log(logging.INFO, event, local_failure)
        return
    try:
        clear_failure = getattr(store, "clear_background_job_failure", None)
        if clear_failure is None:
            raise AttributeError("background health recovery is unavailable")
        previous = await clear_failure(job_name, failure_id)
    except Exception:
        _record_local_background_job_failure(store, job_name)
        _log_health_store_unavailable()
        return
    if isinstance(previous, dict):
        _clear_local_background_job_failure(store, job_name)
        _log(logging.INFO, event, {**(observed_failure or {}), **previous})


def _public_failure(failure: dict[str, Any]) -> dict[str, Any]:
    return {field: failure[field] for field in PUBLIC_FAILURE_FIELDS}


def _record_local_background_job_failure(
    store: Any,
    job_name: str,
    *,
    failure: dict[str, Any] | None = None,
    source: str = PERSISTENCE_FAILURE_SOURCE,
) -> None:
    failures = _local_background_job_failures(store, create=True)
    if failures is not None:
        failures[job_name] = {
            **(failure or _health_store_unavailable()),
            LOCAL_FAILURE_SOURCE: source,
        }


def _clear_local_background_job_failure(store: Any, job_name: str) -> None:
    failures = _local_background_job_failures(store)
    if failures is not None:
        failures.pop(job_name, None)


def _local_background_job_failure(
    store: Any,
    job_name: str | None = None,
) -> dict[str, Any] | None:
    failures = _local_background_job_failures(store)
    if failures is None:
        return None
    if job_name is not None:
        failure = failures.get(job_name)
        return dict(failure) if isinstance(failure, dict) else None
    for name in BACKGROUND_JOBS:
        failure = failures.get(name)
        if isinstance(failure, dict):
            return dict(failure)
    return None


def _local_background_job_failures(
    store: Any,
    *,
    create: bool = False,
) -> dict[str, dict[str, Any]] | None:
    failures = getattr(store, LOCAL_FAILURES_ATTRIBUTE, None)
    if isinstance(failures, dict):
        return failures
    if not create:
        return None
    failures = {}
    try:
        setattr(store, LOCAL_FAILURES_ATTRIBUTE, failures)
    except Exception:
        return None
    return failures
