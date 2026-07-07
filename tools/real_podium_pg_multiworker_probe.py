from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

import httpx

from podium.app import create_app
from podium.store.postgres import PgStore


def _app(pg_store: PgStore) -> Any:
    return create_app(
        turnstile_verifier=lambda token, _ip: token == "turnstile-ok",
        secure_cookies=False,
        secret_key="real-pg-multiworker-probe",
        pg_store=pg_store,
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


def _agent_session_payload(*, workspace_id: str) -> dict[str, Any]:
    return {
        "type": "AgentSessionEvent",
        "workspace": {"id": workspace_id},
        "agentSession": {
            "id": "pg-multiworker-session-1",
            "appUserId": "agent-alpha",
            "issue": {
                "id": "pg-multiworker-issue-1",
                "identifier": "ALPHA-1",
                "project": {"slugId": "ALPHA"},
                "delegate": {"id": "agent-alpha"},
            },
        },
    }


async def run_probe(args: argparse.Namespace) -> dict[str, Any]:
    store = await PgStore.connect(args.database_url)
    try:
        await store.migrate()

        enrollment_app = _app(store)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=enrollment_app), base_url="http://podium.test") as client:
            user_id = await _register(client)
            enrolled = await _enroll(client)
            report = await client.post(
                "/api/v1/runtime/report",
                headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
                json={
                    "bindings": [
                        {
                            "instance_id": "inst-a",
                            "project_slug": "ALPHA",
                            "agent_app_user_id": "agent-alpha",
                            "pipeline_profile": "gated-task",
                        }
                    ]
                },
            )
            report.raise_for_status()

        webhook_app = _app(store)
        webhook_started_empty = (
            webhook_app.state.podium.runtime_groups == {}
            and webhook_app.state.podium.project_bindings == {}
        )
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=webhook_app), base_url="http://podium.test") as client:
            queued = await client.post(
                "/api/v1/linear/webhooks/agent-session",
                json=_agent_session_payload(workspace_id=user_id),
            )
            queued.raise_for_status()

        lease_app = _app(store)
        lease_started_empty = lease_app.state.podium.runtimes == {} and lease_app.state.podium.runtime_groups == {}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=lease_app), base_url="http://podium.test") as client:
            lease = await client.post(
                "/api/v1/runtime/dispatches/lease",
                headers={"Authorization": f"Bearer {enrolled['runtime_token']}"},
            )
            lease.raise_for_status()

        dispatch = lease.json().get("dispatch")
        binding_id = f"{enrolled['runtime_id']}:inst-a"
        summary = {
            "pass": bool(
                report.json().get("bindings_upserted") == 1
                and queued.json().get("queued") == 1
                and isinstance(dispatch, dict)
                and dispatch.get("project_binding_id") == binding_id
                and dispatch.get("fencing_token") == 1
                and webhook_started_empty
                and lease_started_empty
            ),
            "runtime_id": enrolled["runtime_id"],
            "binding_id": binding_id,
            "report_bindings_upserted": report.json().get("bindings_upserted"),
            "queued": queued.json().get("queued"),
            "leased_dispatch": dispatch,
            "webhook_worker_started_without_memory": webhook_started_empty,
            "lease_worker_started_without_memory": lease_started_empty,
        }
    finally:
        await store.close()

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    return summary


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
