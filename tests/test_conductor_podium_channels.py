from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from conductor.conductor_models import ConductorSettings
from conductor.conductor_runtime import ConductorRuntimeManager
from conductor.podium_client import PodiumRuntimeClient
from conductor.conductor_service import ConductorService
from conductor.conductor_store import ConductorStore
from performer_api.ops_models import IssueRecord, OpsSnapshot, RunRecord
from performer_api.ops_store import OpsStore
from podium.app import create_app
from tests.test_conductor_service import CapturingRuntime, make_repo, make_request


class ChannelRuntime(CapturingRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.real = ConductorRuntimeManager(command="performer")

    def query_logs(self, instance, query=None):
        return self.real.query_logs(instance, query)

    def read_logs(self, instance):
        return self.real.read_logs(instance)


def make_channel_service(tmp_path: Path) -> ConductorService:
    runtime = ChannelRuntime()
    return ConductorService(
        store=ConductorStore(tmp_path / "conductor-data"),
        data_root=tmp_path / "conductor-data",
        runtime_manager=runtime,  # type: ignore[arg-type]
    )


def test_build_podium_report_includes_bindings_metrics_queue_and_log_tail(tmp_path: Path) -> None:
    service = make_channel_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    current = Path(instance.instance_dir) / "logs" / "performer-000001.log"
    current.write_text("one\ntwo\nthree\n", encoding="utf-8")
    service.store.update_instance(instance.with_updates(log_path=str(current), process_status="running"))

    report = service.build_podium_report(log_tail_lines=2)

    assert report["bindings"][0]["instance_id"] == instance.id
    assert report["bindings"][0]["project_slug"] == "ENG"
    assert report["bindings"][0]["process_status"] == "running"
    assert report["metrics"][instance.id]["tokens"] == 0
    assert report["queue"][instance.id]["running"] == 1
    assert report["log_tail"][instance.id]["lines"] == ["three", "two"]


@pytest.mark.asyncio
async def test_post_podium_report_sends_bearer_runtime_token(tmp_path: Path) -> None:
    service = make_channel_service(tmp_path)
    service.store.save_settings(
        ConductorSettings(
            podium_url="https://podium.test",
            podium_runtime_id="runtime-1",
            podium_runtime_token="runtime-token",
        )
    )
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["authorization"] = request.headers.get("Authorization")
        captured["body"] = json.loads(request.content.decode())
        return httpx.Response(200, json={"status": "ok"})

    result = await service.post_podium_report(transport=httpx.MockTransport(handler))

    assert result == {"status": "ok"}
    assert captured["url"] == "https://podium.test/api/v1/runtime/report"
    assert captured["authorization"] == "Bearer runtime-token"
    assert "bindings" in captured["body"]


@pytest.mark.asyncio
async def test_ack_completed_podium_dispatch_posts_runtime_completion(tmp_path: Path) -> None:
    service = make_channel_service(tmp_path)
    service.store.save_settings(
        ConductorSettings(
            podium_url="https://podium.test",
            podium_runtime_id="runtime-1",
            podium_runtime_token="runtime-token",
        )
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo).with_overrides(linear_filters={"agent_app_user_id": "agent-alpha"}))
    service.store.update_instance(instance.with_updates(process_status="exited", last_exit_code=0))
    OpsStore(Path(instance.persistence_path).parent / "ops.json").save(
        OpsSnapshot(
            issues={
                "issue-1": IssueRecord(
                    issue_id="issue-1",
                    issue_identifier="ENG-1",
                    title="Task",
                    state="completed",
                    run_count=1,
                )
            },
            runs={"run-1": RunRecord(run_id="run-1", issue_id="issue-1", instance_id=instance.id, status="completed")},
        )
    )
    service._active_podium_dispatches[instance.id] = {"dispatch_id": "dispatch-1", "issue_id": "issue-1"}
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["authorization"] = request.headers.get("Authorization")
        captured["body"] = json.loads(request.content.decode())
        return httpx.Response(200, json={"dispatch": {"status": "completed"}})

    result = await service.ack_completed_podium_dispatches(transport=httpx.MockTransport(handler))

    assert result == {"acked": 1, "failed": 0, "skipped": 0}
    assert captured["url"] == "https://podium.test/api/v1/runtime/dispatches/ack"
    assert captured["authorization"] == "Bearer runtime-token"
    assert captured["body"] == {
        "dispatch_id": "dispatch-1",
        "status": "completed",
        "reason": "completed_by_runtime",
        "runtime_phase": "completed",
    }


@pytest.mark.asyncio
async def test_handle_podium_ws_dispatch_and_log_fetch_commands(tmp_path: Path) -> None:
    service = make_channel_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(linear_filters={"agent_app_user_id": "agent-alpha"})
    )
    current = Path(instance.instance_dir) / "logs" / "performer-000001.log"
    current.write_text("one\ntwo\nthree\n", encoding="utf-8")
    service.store.update_instance(instance.with_updates(log_path=str(current)))
    posted_chunks: list[dict[str, Any]] = []

    async def post_chunk(payload: dict[str, Any]) -> dict[str, Any]:
        posted_chunks.append(payload)
        return {"status": "accepted"}

    dispatch = await service.handle_podium_ws_command(
        {
            "type": "dispatch.available",
            "instance_id": instance.id,
            "dispatch": {"issue_id": "issue-1", "project_slug": "ENG", "agent_app_user_id": "agent-alpha"},
        }
    )
    fetch = await service.handle_podium_ws_command(
        {
            "type": "log.fetch",
            "request_id": "req-1",
            "instance_id": instance.id,
            "tail": 2,
            "previous": False,
            "order": "desc",
        },
        post_log_chunk=post_chunk,
    )

    assert dispatch["status"] == "accepted"
    assert service.runtime_manager.started_dispatch_issue_ids == ["issue-1"]  # type: ignore[attr-defined]
    assert fetch["status"] == "posted"
    assert posted_chunks[0]["request_id"] == "req-1"
    assert posted_chunks[0]["lines"] == ["three", "two"]


@pytest.mark.asyncio
async def test_conductor_report_posts_to_podium_app_and_surfaces_binding(tmp_path: Path) -> None:
    app = create_app(turnstile_verifier=lambda token, _ip: token == "turnstile-ok", secure_cookies=False)
    service = make_channel_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://podium.test") as client:
        registered = await client.post(
            "/api/v1/auth/register",
            json={"email": "bridge@example.com", "password": "correct-horse", "turnstile_token": "turnstile-ok"},
        )
        token_response = await client.post("/api/v1/onboarding/runtime/enrollment-token")
        enrolled = (
            await client.post("/api/v1/runtime/enroll", json={"enrollment_token": token_response.json()["enrollment_token"]})
        ).json()
        service.store.save_settings(
            ConductorSettings(
                podium_url="http://podium.test",
                podium_runtime_id=enrolled["runtime_id"],
                podium_runtime_token=enrolled["runtime_token"],
                podium_proxy_token=enrolled["proxy_token"],
            )
        )

        posted = await service.post_podium_report(transport=httpx.ASGITransport(app=app), log_tail_lines=1)
        listed = await client.get("/api/v1/runtimes")

    assert registered.status_code == 200
    assert posted["status"] == "ok"
    assert listed.json()["conductors"][0]["bindings"][0]["instance_id"] == instance.id


@pytest.mark.asyncio
async def test_podium_runtime_client_ws_once_sends_hello_and_handles_command(tmp_path: Path) -> None:
    service = make_channel_service(tmp_path)
    service.store.save_settings(
        ConductorSettings(
            podium_ws_url="ws://podium.test/api/v1/runtime/ws",
            podium_runtime_token="runtime-token",
        )
    )
    handled: list[dict[str, Any]] = []

    class FakeWebSocket:
        def __init__(self) -> None:
            self.sent: list[str] = []
            self.messages = ['{"type":"ping"}', '{"type":"dispatch.available","dispatch":{"issue_id":"issue-1","agent_app_user_id":"agent"}}']

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def send(self, payload: str) -> None:
            self.sent.append(payload)

        async def recv(self) -> str:
            return self.messages.pop(0)

    fake = FakeWebSocket()

    def connect(url: str, **kwargs: Any):
        assert url == "ws://podium.test/api/v1/runtime/ws"
        assert kwargs["additional_headers"]["Authorization"] == "Bearer runtime-token"
        return fake

    async def fake_handle(command: dict[str, Any], **_kwargs: Any) -> dict[str, Any]:
        handled.append(command)
        return {"status": "accepted"}

    client = PodiumRuntimeClient(service)
    client.handle_command = fake_handle  # type: ignore[method-assign]

    result = await client.run_ws_once(connect=connect)

    assert result == {"status": "ok", "handled": 1}
    assert fake.sent == ['{"type":"hello"}']
    assert handled[0]["type"] == "dispatch.available"
