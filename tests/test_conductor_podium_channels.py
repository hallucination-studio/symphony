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
from performer_api.phase import PhaseAdvanceResult, RunPhase
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


class FailingChildIssueTracker:
    def __init__(self) -> None:
        self.fetch_calls = 0

    async def fetch_child_issues(self, parent_issue_id: str, *, label_name: str | None = None) -> list[dict[str, Any]]:
        self.fetch_calls += 1
        raise AssertionError("managed human.answered must not poll Linear child issues")


def test_build_podium_report_includes_bindings_metrics_queue_and_log_tail(tmp_path: Path) -> None:
    service = make_channel_service(tmp_path)
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    waiting = service.store.upsert_orchestration_run(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id=None,
    )
    failed = service.store.upsert_orchestration_run(
        instance_id=instance.id,
        issue_id="issue-2",
        issue_identifier="ENG-2",
        workflow_profile="default",
        dispatch_id=None,
    )
    service.store.update_orchestration_run(waiting.run_id, phase=RunPhase.AWAITING_HUMAN, status="waiting")
    service.store.update_orchestration_run(failed.run_id, phase=RunPhase.FAILED, status="failed", retry_count=2)
    current = Path(instance.instance_dir) / "logs" / "performer-000001.log"
    current.write_text("one\ntwo\nthree\n", encoding="utf-8")
    service.store.update_instance(instance.with_updates(log_path=str(current), process_status="running"))

    report = service.build_podium_report(log_tail_lines=2)

    assert report["bindings"][0]["instance_id"] == instance.id
    assert report["bindings"][0]["project_slug"] == "ENG"
    assert report["bindings"][0]["process_status"] == "running"
    assert report["metrics"][instance.id]["tokens"] == 0
    assert report["metrics"][instance.id]["retries"] == 2
    assert report["metrics"][instance.id]["blocked"] == 1
    assert report["metrics"][instance.id]["pending_human"] == 1
    assert report["metrics"][instance.id]["failures"] == 1
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
    run = service.store.upsert_orchestration_run(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )
    service.store.update_orchestration_run(
        run.run_id,
        phase=RunPhase.DONE,
        status="completed",
        last_reason="completed_by_runtime",
        ack_status="pending",
    )
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
        "runtime_phase": "done",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [404, 409])
async def test_ack_completed_podium_dispatch_treats_missing_or_conflict_as_terminal(
    tmp_path: Path,
    status_code: int,
) -> None:
    service = make_channel_service(tmp_path)
    service.store.save_settings(
        ConductorSettings(
            podium_url="https://podium.test",
            podium_runtime_id="runtime-1",
            podium_runtime_token="runtime-token",
        )
    )
    repo = make_repo(tmp_path)
    instance = service.create_instance(make_request(repo))
    run = service.store.upsert_orchestration_run(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile="default",
        dispatch_id="dispatch-1",
    )
    service.store.update_orchestration_run(
        run.run_id,
        phase=RunPhase.DONE,
        status="completed",
        ack_status="pending",
    )

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json={"error": "already terminal"})

    result = await service.ack_completed_podium_dispatches(transport=httpx.MockTransport(handler))

    updated = service.store.get_orchestration_run(run.run_id)
    assert result == {"acked": 1, "failed": 0, "skipped": 0}
    assert updated is not None
    assert updated.ack_status == "acked"


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

    assert dispatch["status"] == "queued"
    assert service.runtime_manager.started_phase_issue_ids == []  # type: ignore[attr-defined]
    assert await service._drain_podium_dispatch_queue() == 1
    assert service.runtime_manager.started_phase_issue_ids == ["issue-1"]  # type: ignore[attr-defined]
    assert fetch["status"] == "posted"
    assert posted_chunks[0]["request_id"] == "req-1"
    assert posted_chunks[0]["lines"] == ["three", "two"]


@pytest.mark.asyncio
async def test_handle_podium_ws_human_answered_resumes_without_child_poll(tmp_path: Path) -> None:
    service = make_channel_service(tmp_path)
    service.store.save_settings(ConductorSettings(managed_mode=True, podium_proxy_token="proxy-token"))
    tracker = FailingChildIssueTracker()
    service.repository_handoff_tracker_factory = lambda instance: tracker
    repo = make_repo(tmp_path)
    instance = service.create_instance(
        make_request(repo).with_overrides(linear_filters={"agent_app_user_id": "agent-alpha"})
    )
    run = service.phase_reducer.dispatch_received(
        instance_id=instance.id,
        issue_id="issue-1",
        issue_identifier="ENG-1",
        workflow_profile=instance.workflow_profile,
        dispatch_id="dispatch-1",
    )
    service.phase_reducer.performer_started(run.run_id, request_path="/tmp/request.json", result_path="/tmp/result.json")
    service.phase_reducer.performer_result(
        PhaseAdvanceResult(
            run_id=run.run_id,
            issue_id="issue-1",
            next_phase=RunPhase.AWAITING_HUMAN,
            status="awaiting_human",
            human_action={
                "child_issue_id": "child-1",
                "child_identifier": "ENG-2",
                "kind": "runtime_error",
            },
        )
    )

    response = await service.handle_podium_ws_command(
        {
            "type": "human.answered",
            "child_issue_id": "child-1",
            "human_response": "Restart approved.",
        }
    )

    updated = service.store.get_orchestration_run(run.run_id)
    assert response == {"status": "accepted", "run_id": run.run_id, "issue_id": "issue-1"}
    assert updated is not None
    assert updated.phase is RunPhase.QUEUED
    assert updated.human_response == "Restart approved."
    assert tracker.fetch_calls == 0


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
