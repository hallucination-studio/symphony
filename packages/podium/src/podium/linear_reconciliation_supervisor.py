from __future__ import annotations

import asyncio
import logging
from typing import Any, Protocol

from .podium_health import (
    LINEAR_RECONCILIATION_JOB,
    clear_background_job_failure,
    linear_reconciliation_loop_failure,
    load_background_job_failure,
    record_background_job_failure,
)


LOGGER = logging.getLogger("podium.linear_reconciliation")
DEFAULT_CYCLE_TIMEOUT_SECONDS = 60.0


class Reconciler(Protocol):
    state: Any

    async def reconcile_once(self) -> dict[str, int]: ...


class LinearReconciliationCycleError(RuntimeError):
    pass


async def run_linear_reconciliation_loop(
    reconciler: Reconciler,
    *,
    interval_seconds: float,
    cycle_timeout_seconds: float | None = None,
) -> None:
    interval = max(1.0, float(interval_seconds or 1.0))
    cycle_timeout = max(
        0.01,
        float(
            DEFAULT_CYCLE_TIMEOUT_SECONDS
            if cycle_timeout_seconds is None
            else cycle_timeout_seconds
        ),
    )
    store = reconciler.state.store
    while True:
        observed_failure = None
        try:
            observed_failure = await load_background_job_failure(
                store,
                LINEAR_RECONCILIATION_JOB,
            )
            LOGGER.info(
                "event=linear_reconciliation_cycle_started timeout_seconds=%s",
                cycle_timeout,
            )
            totals = await asyncio.wait_for(
                reconciler.reconcile_once(),
                timeout=cycle_timeout,
            )
            errors = int(totals.get("errors") or 0)
            if errors:
                raise LinearReconciliationCycleError(
                    f"{errors} binding reconciliation error(s)"
                )
        except Exception as exc:
            await record_background_job_failure(
                store,
                LINEAR_RECONCILIATION_JOB,
                linear_reconciliation_loop_failure(type(exc).__name__),
                event="podium_linear_reconciliation_loop_failed",
            )
        else:
            await clear_background_job_failure(
                store,
                LINEAR_RECONCILIATION_JOB,
                observed_failure,
                event="podium_linear_reconciliation_loop_recovered",
            )
        await asyncio.sleep(interval)
