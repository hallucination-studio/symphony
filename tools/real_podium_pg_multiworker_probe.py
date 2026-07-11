from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import uuid4

import asyncpg
from podium.linear_reconciliation import LinearReconciler
from podium.store.postgres import PgStore

if __package__:
    from .real_podium_pg_multiworker_fixture import (
        BINDING_ID,
        ISSUE_ID,
        RUNTIME_ID,
        app_for,
        linear_transport,
        seed_durable_route,
    )
else:
    from real_podium_pg_multiworker_fixture import (
        BINDING_ID,
        ISSUE_ID,
        RUNTIME_ID,
        app_for,
        linear_transport,
        seed_durable_route,
    )


SCHEMA_PREFIX = "podium_multiworker_"


async def run_probe(args: argparse.Namespace) -> dict[str, Any]:
    database_url = str(getattr(args, "database_url", "") or "").strip()
    if not database_url:
        raise RuntimeError("PODIUM_TEST_DATABASE_URL is required")

    schema = f"{SCHEMA_PREFIX}{uuid4().hex}"
    await _create_schema(database_url, schema)
    isolated_url = _with_search_path(database_url, schema)
    try:
        report = await _run_workers(isolated_url)
    finally:
        await _drop_schema(database_url, schema)

    report["cleanup"] = {"schema_dropped": True}
    _write_report(getattr(args, "out", None), report)
    return report


async def _run_workers(database_url: str) -> dict[str, Any]:
    first = await PgStore.connect(database_url)
    second: PgStore | None = None
    try:
        await first.migrate()
        second = await PgStore.connect(database_url)
        first_state = app_for(first).state.podium
        second_state = app_for(second).state.podium
        await seed_durable_route(first_state)

        reconciliation = await asyncio.gather(
            LinearReconciler(state=first_state, transport=linear_transport).reconcile_once(),
            LinearReconciler(state=second_state, transport=linear_transport).reconcile_once(),
        )
        leases = await asyncio.gather(
            first_state.lease_dispatch(RUNTIME_ID),
            second_state.lease_dispatch(RUNTIME_ID),
        )
    finally:
        if second is not None:
            await second.close()
        await first.close()

    return await _restart_report(database_url, reconciliation, leases)


async def _restart_report(
    database_url: str,
    reconciliation: list[dict[str, int]],
    leases: list[dict[str, Any] | None],
) -> dict[str, Any]:
    restarted = await PgStore.connect(database_url)
    try:
        checkpoint = await restarted.get_linear_reconciliation_state(BINDING_ID) or {}
        observation = await restarted.get_linear_issue_observation(BINDING_ID, ISSUE_ID) or {}
        runtime = await restarted.get_runtime(RUNTIME_ID)
        binding = await restarted.get_project_binding(BINDING_ID)
        dispatch_count = int(await restarted.pool.fetchval("SELECT count(*) FROM dispatches") or 0)
        dispatch = await restarted.pool.fetchrow(
            "SELECT status, intake_key, fencing_token, leased_conductor_id FROM dispatches"
        )
    finally:
        await restarted.close()

    winners = [lease for lease in leases if lease is not None]
    durable = {
        "dispatch_count": dispatch_count,
        "dispatch_status": str(dispatch["status"]) if dispatch else "",
        "intake_key": str(dispatch["intake_key"]) if dispatch else "",
        "checkpoint_baseline_complete": bool(checkpoint.get("baseline_complete")),
        "checkpoint_page_cursor": str(checkpoint.get("page_cursor") or ""),
        "delegated": bool(observation.get("delegated")),
        "delegation_epoch": int(observation.get("delegation_epoch") or 0),
        "fencing_token": int(dispatch["fencing_token"]) if dispatch else 0,
        "reconciliation_error_code": str(checkpoint.get("last_error_code") or ""),
        "reconciliation_retry_count": int(checkpoint.get("retry_count") or 0),
        "restart_readable": bool(
            runtime
            and binding
            and checkpoint
            and observation
            and dispatch
            and dispatch["leased_conductor_id"] == RUNTIME_ID
        ),
    }
    workers = {
        "pool_count": 2,
        "reconciliation_queued": sorted(result["queued"] for result in reconciliation),
        "reconciliation_error_count": sum(
            int(result.get("errors") or 0) for result in reconciliation
        ),
        "lease_winner_count": len(winners),
    }
    expected_durable = {
        "dispatch_count": 1,
        "dispatch_status": "leased",
        "intake_key": f"linear-issue:{ISSUE_ID}:epoch:1",
        "checkpoint_baseline_complete": True,
        "checkpoint_page_cursor": "",
        "delegated": True,
        "delegation_epoch": 1,
        "fencing_token": 1,
        "reconciliation_error_code": "",
        "reconciliation_retry_count": 0,
        "restart_readable": True,
    }
    passed = (
        workers == {
            "pool_count": 2,
            "reconciliation_queued": [0, 1],
            "reconciliation_error_count": 0,
            "lease_winner_count": 1,
        }
        and durable == expected_durable
    )
    report = {"pass": passed, "workers": workers, "durable": durable}
    if not passed:
        report.update(_semantic_failure(workers, durable))
    return report


def _semantic_failure(
    workers: dict[str, Any],
    durable: dict[str, Any],
) -> dict[str, Any]:
    reconciliation_errors = int(workers.get("reconciliation_error_count") or 0)
    if reconciliation_errors:
        return _failure_fields(
            "ReconciliationSemanticFailure",
            str(
                durable.get("reconciliation_error_code")
                or "linear_reconciliation_failed"
            ),
            (
                "PostgreSQL multiworker probe observed "
                f"{reconciliation_errors} reconciliation error(s)"
            ),
            "retry_reconciliation",
            True,
            "inspect_reconciliation_health",
        )
    return _failure_fields(
        "ProbeInvariantMismatch",
        "pg_multiworker_invariant_mismatch",
        "PostgreSQL multiworker probe did not satisfy its durable invariants",
        "inspect_postgres_probe",
        False,
        "inspect_postgres_probe",
    )


async def _create_schema(database_url: str, schema: str) -> None:
    await _schema_statement(database_url, f'CREATE SCHEMA "{schema}"')


async def _drop_schema(database_url: str, schema: str) -> None:
    await _schema_statement(database_url, f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')


async def _schema_statement(database_url: str, statement: str) -> None:
    connection = await asyncpg.connect(database_url)
    try:
        await connection.execute(statement)
    finally:
        await connection.close()


def _with_search_path(database_url: str, schema: str) -> str:
    parsed = urlsplit(database_url)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query["search_path"] = schema
    return urlunsplit(parsed._replace(query=urlencode(query)))


def _write_report(path: Path | None, report: dict[str, Any]) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")


def _failure_report(error: Exception) -> dict[str, Any]:
    return _failure_fields(
        type(error).__name__,
        "pg_multiworker_probe_failed",
        f"PostgreSQL multiworker probe failed ({type(error).__name__})",
        "inspect_postgres_probe",
        False,
        "inspect_postgres_probe",
    )


def _failure_fields(
    error_type: str,
    error_code: str,
    sanitized_reason: str,
    action_required: str,
    retryable: bool,
    next_action: str,
) -> dict[str, Any]:
    return {
        "pass": False,
        "error_type": error_type,
        "error_code": error_code,
        "sanitized_reason": sanitized_reason,
        "action_required": action_required,
        "retryable": retryable,
        "attempt_number": 1,
        "next_action": next_action,
    }


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(
        description=(
            "Verify durable Podium PostgreSQL reconciliation and leasing across workers. "
            "The database is read from PODIUM_TEST_DATABASE_URL."
        ),
    )
    arg_parser.set_defaults(database_url=os.environ.get("PODIUM_TEST_DATABASE_URL", ""))
    arg_parser.add_argument("--out", type=Path)
    return arg_parser


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        report = asyncio.run(run_probe(args))
    except Exception as error:
        report = _failure_report(error)
        _write_report(args.out, report)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
