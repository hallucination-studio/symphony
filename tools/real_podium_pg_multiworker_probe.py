from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

import httpx

from podium.app import create_app
from podium.linear_polling import LinearDelegatePoller
from podium.store.postgres import PgStore


def _app(pg_store: PgStore) -> Any:
    return create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        secret_key="real-pg-multiworker-probe",
        store=pg_store,
    )


async def _register(client: httpx.AsyncClient) -> str:
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "pg-multiworker-probe@example.com",
            "password": "correct-horse",
            "turnstile_token": "turnstile-ok",
        },
    )
    response.raise_for_status()
    return str(response.json()["user"]["id"])


async def _enroll(client: httpx.AsyncClient) -> dict[str, Any]:
    token_response = await client.post("/api/v1/onboarding/runtime/enrollment-token")
    token_response.raise_for_status()
    enrolled = await client.post(
        "/api/v1/runtime/enroll",
        json={"enrollment_token": token_response.json()["enrollment_token"]},
    )
    enrolled.raise_for_status()
    return dict(enrolled.json())


async def run_probe(args: argparse.Namespace) -> dict[str, Any]:
    store = await PgStore.connect(args.database_url)
    try:
        await store.migrate()
        enrolled, report = await _enroll_and_report_binding(store)
        poller_app = _app(store)
        poller_started_empty = _poller_started_empty(poller_app)
        queued = await _poll_once(poller_app)
        lease_app = _app(store)
        lease_started_empty = _lease_started_empty(lease_app)
        lease = await _lease_dispatch(lease_app, enrolled["runtime_token"])
        summary = _summary(enrolled, report, queued, lease, poller_started_empty, lease_started_empty)
    finally:
        await store.close()

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    return summary


async def _enroll_and_report_binding(store: PgStore) -> tuple[dict[str, Any], httpx.Response]:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app(store)), base_url="http://podium.test") as client:
        await _register(client)
        enrolled = await _enroll(client)
        report = await client.post(
            "/api/v1/runtime/report",
            headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            json={"bindings": [_binding_payload()]},
        )
        report.raise_for_status()
        return enrolled, report


def _binding_payload() -> dict[str, str]:
    return {
        "instance_id": "inst-a",
        "project_slug": "ALPHA",
        "agent_app_user_id": "agent-alpha",
        "pipeline_profile": "gated-task",
    }


def _poller_started_empty(poller_app: Any) -> bool:
    return poller_app.state.podium.runtime_groups == {} and poller_app.state.podium.project_bindings == {}


def _lease_started_empty(lease_app: Any) -> bool:
    return lease_app.state.podium.runtimes == {} and lease_app.state.podium.runtime_groups == {}


async def _poll_once(poller_app: Any) -> dict[str, Any]:
    return await LinearDelegatePoller(
        store=poller_app.state.podium.store,
        application_id="agent-alpha",
        app_token="app-token",
        transport=linear_transport,
        initial_lookback_seconds=86_400,
    ).poll_once()


def linear_transport(request: httpx.Request) -> httpx.Response:
    payload = json.loads(request.content.decode("utf-8"))
    if payload.get("variables", {}).get("projectSlug") != "ALPHA":
        return httpx.Response(400, json={"errors": [{"message": "wrong project"}]})
    if payload.get("variables", {}).get("delegateId") != "agent-alpha":
        return httpx.Response(400, json={"errors": [{"message": "wrong delegate"}]})
    return httpx.Response(200, json={"data": {"issues": {"nodes": [_linear_issue()]}}})


def _linear_issue() -> dict[str, Any]:
    return {
        "id": "pg-multiworker-issue-1",
        "identifier": "ALPHA-1",
        "title": "PG multiworker poll probe",
        "description": "Prove poller dispatch is durable.",
        "updatedAt": "2026-07-08T00:00:00Z",
        "project": {"slugId": "ALPHA"},
        "delegate": {"id": "agent-alpha"},
        "parent": None,
        "inverseRelations": {"nodes": []},
    }


async def _lease_dispatch(lease_app: Any, runtime_token: str) -> httpx.Response:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=lease_app), base_url="http://podium.test") as client:
        lease = await client.post("/api/v1/runtime/dispatches/lease", headers={"Authorization": f"Bearer {runtime_token}"})
        lease.raise_for_status()
        return lease


def _summary(
    enrolled: dict[str, Any],
    report: httpx.Response,
    queued: dict[str, Any],
    lease: httpx.Response,
    poller_started_empty: bool,
    lease_started_empty: bool,
) -> dict[str, Any]:
    dispatch = lease.json().get("dispatch")
    binding_id = f"{enrolled['runtime_id']}:inst-a"
    return {
        "pass": _passed(report, queued, dispatch, binding_id, poller_started_empty, lease_started_empty),
        "runtime_id": enrolled["runtime_id"],
        "binding_id": binding_id,
        "report_bindings_upserted": report.json().get("bindings_upserted"),
        "queued": queued.get("queued"),
        "leased_dispatch": dispatch,
        "poller_worker_started_without_memory": poller_started_empty,
        "lease_worker_started_without_memory": lease_started_empty,
    }


def _passed(
    report: httpx.Response,
    queued: dict[str, Any],
    dispatch: Any,
    binding_id: str,
    poller_started_empty: bool,
    lease_started_empty: bool,
) -> bool:
    return bool(
        report.json().get("bindings_upserted") == 1
        and queued.get("queued") == 1
        and isinstance(dispatch, dict)
        and dispatch.get("project_binding_id") == binding_id
        and dispatch.get("fencing_token") == 1
        and poller_started_empty
        and lease_started_empty
    )


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Verify Podium PG multi-worker enroll, route, and lease.")
    arg_parser.add_argument("--database-url", required=True)
    arg_parser.add_argument("--out", type=Path)
    return arg_parser


def main() -> int:
    args = parser().parse_args()
    summary = asyncio.run(run_probe(args))
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if summary["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
