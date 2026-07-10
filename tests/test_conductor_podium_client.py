from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from conductor.conductor_models import ConductorSettings
from conductor.conductor_service import ConductorService
from conductor.conductor_store import ConductorStore
from conductor.podium_client import PodiumRuntimeClient


def _client(tmp_path: Path) -> PodiumRuntimeClient:
    store = ConductorStore(tmp_path / "conductor")
    store.save_settings(
        ConductorSettings(
            podium_url="https://podium.test/",
            podium_runtime_id="runtime-1",
            podium_runtime_token="runtime-secret",
            runtime_group_id="group-1",
            conductor_id="runtime-1",
            managed_mode=True,
        )
    )
    service = ConductorService(store=store, data_root=tmp_path / "conductor")
    return PodiumRuntimeClient(service)


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [200, 202])
async def test_post_smoke_result_uses_runtime_auth_and_accepts_success_statuses(
    tmp_path: Path,
    status_code: int,
) -> None:
    requests: list[httpx.Request] = []
    payload = {"smoke_check_id": "smoke-1", "status": "passed"}

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(status_code, json={"status": "accepted"}, request=request)

    outcome = await _client(tmp_path).post_smoke_result(payload, transport=httpx.MockTransport(handler))

    assert outcome == {"status": "accepted", "status_code": status_code}
    assert len(requests) == 1
    assert str(requests[0].url) == "https://podium.test/api/v1/runtime/smoke-check/result"
    assert requests[0].headers["Authorization"] == "Bearer runtime-secret"
    assert json.loads(requests[0].content) == payload


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [500, 502, 503])
async def test_post_smoke_result_classifies_server_failures_as_retryable(
    tmp_path: Path,
    status_code: int,
) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code,
            json={"error": {"code": "podium_unavailable", "message": "Podium is unavailable"}},
            request=request,
        )

    outcome = await _client(tmp_path).post_smoke_result({}, transport=httpx.MockTransport(handler))

    assert outcome == {
        "status": "retryable_error",
        "status_code": status_code,
        "error_code": "podium_unavailable",
        "sanitized_reason": "Podium is unavailable",
        "retryable": True,
        "action_required": "retry_smoke_result",
        "next_action": "retry_smoke_result",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [400, 401, 409])
async def test_post_smoke_result_classifies_client_rejections_as_terminal(
    tmp_path: Path,
    status_code: int,
) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code,
            json={"error": {"code": "smoke_result_rejected", "message": "Result was rejected"}},
            request=request,
        )

    outcome = await _client(tmp_path).post_smoke_result({}, transport=httpx.MockTransport(handler))

    assert outcome["status"] == "rejected"
    assert outcome["status_code"] == status_code
    assert outcome["retryable"] is False
    assert outcome["action_required"] == "inspect_smoke_result"
    assert outcome["next_action"] == "rerun_smoke_check"


@pytest.mark.asyncio
async def test_post_smoke_result_sanitizes_untrusted_podium_error(tmp_path: Path) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            409,
            json={
                "error": {
                    "code": "INVALID CODE",
                    "message": "Authorization: Bearer leaked-token token=second-secret\nretry",
                }
            },
            request=request,
        )

    outcome = await _client(tmp_path).post_smoke_result({}, transport=httpx.MockTransport(handler))

    assert outcome["error_code"] == "smoke_result_rejected"
    assert outcome["sanitized_reason"] == "Authorization: [REDACTED] token=[REDACTED] retry"
    assert "leaked-token" not in str(outcome)
    assert "second-secret" not in str(outcome)
