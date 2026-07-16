from __future__ import annotations

import asyncio
from pathlib import Path
import socket
import time

import pytest

from conductor.conductor_service import ConductorService
from conductor.models import LocalRuntimeIdentity
from conductor.podium_ipc import (
    LocalRuntimeClient,
    read_runtime_message,
    write_runtime_message,
)
from conductor.store import ConductorStore
from conductor.workflow_driver import WorkflowDriver
from performer_api import (
    ConfigureCommand,
    DispatchAck,
    DispatchLease,
    DrainAck,
    DrainRequest,
    LocalRuntimeContext,
    LocalRuntimeEnvelope,
    RuntimeReportMessage,
)
from performer_api.runtime_policy import PerformerProfileConfig
from podium.local_sessions import PodiumLocalSession


def identity() -> LocalRuntimeIdentity:
    return LocalRuntimeIdentity(
        "conductor-1", "instance-1", "project-1", "binding-1", 1
    )


def context(correlation_id: str) -> LocalRuntimeContext:
    return LocalRuntimeContext(
        1,
        "conductor-1",
        "instance-1",
        "project-1",
        "binding-1",
        1,
        correlation_id,
    )


def profile() -> PerformerProfileConfig:
    return PerformerProfileConfig.create(
        binding_id="binding-1",
        binding_config_version=1,
        performer_binding_id="performer-binding-1",
        performer_profile_id="performer-profile-1",
        runtime_profile_id="runtime-profile-1",
        performer_kind="codex",
        runtime_kind="codex",
        execution_policy={
            "version": 1,
            "model": "gpt-5.4",
            "model_provider": "openai",
            "approval_mode": "auto_review",
            "reasoning_effort": "high",
            "reasoning_summary": "auto",
            "sandbox": {
                "plan": "read_only",
                "execute": "workspace_write",
                "gate": "read_only",
            },
            "initialize_timeout_ms": 5_000,
            "turn_timeout_ms": 3_600_000,
            "initialize_max_attempts": 4,
            "overload_max_attempts": 5,
        },
        turn_policy={"max_turns": 4},
    )


def configure(repository: Path) -> ConfigureCommand:
    return ConfigureCommand(
        context("configure-1"),
        str(repository),
        "project-slug",
        "Symphony Project",
        "app-user-1",
        1,
        profile(),
    )


def connected_client() -> tuple[LocalRuntimeClient, socket.socket]:
    handshake = LocalRuntimeEnvelope(
        1, "instance-1", "project-1", 1, "session-1", "handshake"
    )
    session, conductor_fd = PodiumLocalSession.create(handshake)
    client = LocalRuntimeClient.connect(
        conductor_fd,
        identity(),
        handshake,
    )
    assert session.accept() == handshake
    return client, session.channel


@pytest.mark.asyncio
async def test_private_tick_orders_configure_report_lease_persist_and_ack(
    tmp_path: Path,
) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    store = ConductorStore(tmp_path / "conductor")
    service = ConductorService(store=store, data_root=tmp_path / "conductor")
    client, podium = connected_client()

    tick = asyncio.create_task(service.private_sync_once(client))
    write_runtime_message(podium, configure(repository))
    report = await asyncio.to_thread(read_runtime_message, podium)
    assert isinstance(report, RuntimeReportMessage)
    assert report.status == "ready"

    lease = DispatchLease(
        context("lease-1"),
        "dispatch-1",
        "issue-1",
        "lease-1",
        7,
        int(time.time()) + 30,
    )
    write_runtime_message(podium, lease)
    acknowledgment = await asyncio.to_thread(read_runtime_message, podium)
    result = await asyncio.wait_for(tick, timeout=1)

    assert acknowledgment == DispatchAck(
        context("lease-1"), "dispatch-1", "lease-1", 7, "accepted", ""
    )
    run = store.list_runs()[0]
    assert run["parent_issue_id"] == "issue-1"
    assert run["payload"]["dispatch_id"] == "dispatch-1"
    assert run["payload"]["lease_id"] == "lease-1"
    assert run["payload"]["dispatch_fencing_token"] == 7
    assert result["status"] == "accepted"
    client.close()
    podium.close()


@pytest.mark.asyncio
async def test_private_tick_does_not_ack_when_durable_apply_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor"),
        data_root=tmp_path / "conductor",
    )
    client, podium = connected_client()
    tick = asyncio.create_task(service.private_sync_once(client))
    write_runtime_message(podium, configure(repository))
    await asyncio.to_thread(read_runtime_message, podium)
    create_run = service.store.create_run

    def fail_create_run(*args, **kwargs):
        raise OSError("raw database failure /private/path")

    monkeypatch.setattr(service.store, "create_run", fail_create_run)
    write_runtime_message(
        podium,
        DispatchLease(
            context("lease-fail"),
            "dispatch-fail",
            "issue-fail",
            "lease-fail",
            8,
            int(time.time()) + 30,
        ),
    )

    with pytest.raises(ValueError, match="private_dispatch_persist_failed"):
        await asyncio.wait_for(tick, timeout=1)
    podium.settimeout(0.05)
    with pytest.raises(TimeoutError):
        podium.recv(1)
    assert service.private_sync_failure is not None
    assert (
        service.private_sync_failure["sanitized_reason"]
        == "private_dispatch_persist_failed"
    )
    assert service.private_sync_failure["correlation_id"] == "lease-fail"
    assert service.private_sync_failure["lease_id"] == "lease-fail"
    instance = service.store.list_instances()[0]
    failure_log = Path(instance.log_path).read_text()
    assert "event=private_sync_failed" in failure_log
    assert "correlation_id=lease-fail" in failure_log
    assert "fencing_token=8" in failure_log
    assert "/private/path" not in str(service.private_sync_failure)
    assert "/private/path" not in failure_log

    monkeypatch.setattr(service.store, "create_run", create_run)
    retry = asyncio.create_task(service.private_sync_once(client))
    write_runtime_message(podium, configure(repository))
    degraded = await asyncio.to_thread(read_runtime_message, podium)
    assert degraded.status == "degraded"
    assert degraded.error_code == "private_dispatch_persist_failed"
    write_runtime_message(
        podium,
        DispatchLease(
            context("lease-retry"),
            "dispatch-retry",
            "issue-fail",
            "lease-retry",
            9,
            int(time.time()) + 30,
        ),
    )
    assert (await asyncio.to_thread(read_runtime_message, podium)).status == "accepted"
    await asyncio.wait_for(retry, timeout=1)
    client.close()
    podium.close()


@pytest.mark.asyncio
async def test_restarted_tick_reapplies_same_lease_without_duplicate_run(
    tmp_path: Path,
) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    store = ConductorStore(tmp_path / "conductor")
    lease = DispatchLease(
        context("lease-restart"),
        "dispatch-restart",
        "issue-restart",
        "lease-restart",
        9,
        int(time.time()) + 30,
    )

    for _ in range(2):
        service = ConductorService(store=store, data_root=tmp_path / "conductor")
        client, podium = connected_client()
        tick = asyncio.create_task(service.private_sync_once(client))
        write_runtime_message(podium, configure(repository))
        assert isinstance(
            await asyncio.to_thread(read_runtime_message, podium),
            RuntimeReportMessage,
        )
        write_runtime_message(podium, lease)
        acknowledgment = await asyncio.to_thread(read_runtime_message, podium)
        assert acknowledgment.status == "accepted"
        await asyncio.wait_for(tick, timeout=1)
        client.close()
        podium.close()

    assert len(store.list_runs()) == 1
    assert store.list_runs()[0]["payload"]["dispatch_fencing_token"] == 9


@pytest.mark.asyncio
async def test_drain_closes_admission_before_driver_and_returns_only_drain_ack(
    tmp_path: Path, minimal_plan
) -> None:
    store = ConductorStore(tmp_path / "conductor")
    run = store.create_run("issue-1", "APP-1", instance_id="instance-1")
    attempt = store.start_plan(run["run_id"])
    service = ConductorService(store=store, data_root=tmp_path / "conductor")
    client, podium = connected_client()
    tick = asyncio.create_task(service.private_sync_once(client))
    request = DrainRequest(context("drain-1"), int(time.time()) + 2)
    write_runtime_message(podium, request)

    await asyncio.sleep(0.02)
    assert not service.accepting_private_turns
    assert await WorkflowDriver(service).drive_once() == {
        "started": 0,
        "applied": 0,
        "failed": 0,
    }
    store.record_plan(
        run["run_id"],
        attempt["attempt_id"],
        attempt["fencing_token"],
        minimal_plan,
    )
    acknowledgment = await asyncio.to_thread(read_runtime_message, podium)
    assert isinstance(acknowledgment, DrainAck)
    assert acknowledgment.status == "drained"
    assert (await asyncio.wait_for(tick, timeout=1))["status"] == "drained"
    client.close()
    podium.close()


@pytest.mark.asyncio
async def test_closed_private_client_records_bounded_visible_failure(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    service = ConductorService(
        store=ConductorStore(tmp_path / "conductor"),
        data_root=tmp_path / "conductor",
    )
    client, podium = connected_client()
    client.close()

    with caplog.at_level("WARNING"):
        with pytest.raises(ValueError, match="podium_ipc_closed"):
            await service.private_sync_once(client)

    assert service.private_sync_failure is not None
    assert service.private_sync_failure["event"] == "private_sync_failed"
    assert service.private_sync_failure["sanitized_reason"] == "podium_ipc_closed"
    assert "event=private_sync_failed" in caplog.text
    assert "conductor_id=conductor-1" in caplog.text
    assert "instance_id=instance-1" in caplog.text
    podium.close()


def test_active_private_startup_has_no_legacy_http_sync_calls() -> None:
    cli_source = Path(
        __import__("conductor.conductor_cli", fromlist=["*"]).__file__
    ).read_text()
    api_source = Path(
        __import__("conductor.conductor_api", fromlist=["*"]).__file__
    ).read_text()
    private_branch = cli_source.split("async def run_private_runtime", 1)[1].split(
        "def _install_stop_signals", 1
    )[0]
    legacy_calls = {
        "post_podium_report",
        "poll_podium_dispatch_once",
        "_poll_live_once",
        "_poll_command_once",
        "Authorization",
        "Bearer",
        "podium_url",
        "podium_runtime_token",
    }

    assert all(call not in private_branch for call in legacy_calls)
    start_body = api_source.split("async def start", 1)[1].split(
        "async def stop", 1
    )[0]
    assert "_poll_podium_dispatches" not in start_body
