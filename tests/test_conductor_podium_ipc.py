from __future__ import annotations

import asyncio
import inspect
import logging
import socket
import sqlite3
import struct
import time

import pytest

from conductor.conductor_service import ConductorService
from conductor.models import LocalRuntimeIdentity
from conductor.podium_ipc import LocalRuntimeClient, read_runtime_message, write_runtime_message
from conductor.store import ConductorStore
from performer_api import (
    ConfigureCommand,
    DispatchAck,
    DispatchLease,
    DrainRequest,
    LocalRuntimeContext,
    LocalRuntimeEnvelope,
    RuntimeReportMessage,
)


def identity(*, generation: int = 2) -> LocalRuntimeIdentity:
    return LocalRuntimeIdentity(
        conductor_id="conductor-1",
        instance_id="instance-1",
        project_id="project-1",
        binding_id="binding-1",
        binding_generation=generation,
    )


def context(correlation_id: str, *, generation: int = 2) -> LocalRuntimeContext:
    value = identity(generation=generation)
    return LocalRuntimeContext(
        1,
        value.conductor_id,
        value.instance_id,
        value.project_id,
        value.binding_id,
        value.binding_generation,
        correlation_id,
    )


def connected_client() -> tuple[LocalRuntimeClient, socket.socket]:
    parent, child = socket.socketpair()
    child_fd = child.detach()
    handshake = LocalRuntimeEnvelope(1, "instance-1", "project-1", 2, "session-1", "handshake")
    client = LocalRuntimeClient.connect(child_fd, identity(), handshake)
    size = struct.unpack(">I", parent.recv(4))[0]
    assert LocalRuntimeEnvelope.from_dict(__import__("json").loads(parent.recv(size))) == handshake
    return client, parent


def test_client_validates_identity_before_sending_handshake() -> None:
    parent, child = socket.socketpair()
    child_fd = child.detach()
    stale = LocalRuntimeEnvelope(1, "instance-1", "project-1", 1, "session-1", "handshake")

    with pytest.raises(ValueError, match="podium_ipc_handshake_mismatch"):
        LocalRuntimeClient.connect(child_fd, identity(), stale)

    parent.close()


@pytest.mark.parametrize(
    "value",
    ["sk-abcdefghijklmnopqrstuvwxyz123456", "abcdefghij.abcdefghij.abcdefghij"],
)
def test_identity_rejects_secret_like_log_material(value: str) -> None:
    with pytest.raises(ValueError, match="conductor_id_invalid"):
        LocalRuntimeIdentity(value, "instance-1", "project-1", "binding-1", 1)


def test_client_receives_configure_and_lease_and_sends_report_and_ack() -> None:
    client, podium = connected_client()
    configure = ConfigureCommand(context("configure-1"), "/workspace/repo", "profile-1", 3)
    lease = DispatchLease(context("lease-1"), "dispatch-1", "issue-1", "lease-1", 4, 100)

    write_runtime_message(podium, configure)
    write_runtime_message(podium, lease)
    assert client.receive() == configure
    assert client.receive() == lease

    report = RuntimeReportMessage(context("report-1"), "ready", 10, "", 0, "none")
    ack = DispatchAck(context("lease-1"), "dispatch-1", "lease-1", 4, "accepted", "")
    client.send(report)
    client.send(ack)
    assert read_runtime_message(podium) == report
    assert read_runtime_message(podium) == ack
    client.close()
    podium.close()


def test_client_rejects_stale_or_wrong_session_messages(caplog) -> None:
    client, podium = connected_client()
    write_runtime_message(
        podium,
        ConfigureCommand(context("configure-old", generation=1), "/workspace/repo", "profile-1", 3),
    )

    with caplog.at_level(logging.ERROR):
        with pytest.raises(ValueError, match="podium_ipc_context_mismatch"):
            client.receive()
    assert client.closed
    assert "event=conductor_podium_ipc_failed" in caplog.text
    assert "binding_id=binding-1" in caplog.text
    assert "error_code=podium_ipc_context_mismatch" in caplog.text
    podium.close()


@pytest.mark.asyncio
async def test_drain_waits_for_active_result_persistence_then_acks(
    tmp_path, minimal_plan
) -> None:
    store = ConductorStore(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    attempt = store.start_plan(run["run_id"])
    service = ConductorService(store=store, data_root=tmp_path)
    client, podium = connected_client()
    request = DrainRequest(context("drain-1"), int(time.time()) + 3)

    draining = asyncio.create_task(client.handle_drain(request, service))
    await asyncio.sleep(0.02)
    assert not service.accepting_private_turns
    assert not draining.done()

    store.record_plan(
        run["run_id"], attempt["attempt_id"], attempt["fencing_token"], minimal_plan
    )
    acknowledged = await asyncio.wait_for(draining, timeout=1)

    assert acknowledged.status == "drained"
    assert read_runtime_message(podium) == acknowledged
    assert await client.handle_drain(request, service) == acknowledged
    assert read_runtime_message(podium) == acknowledged
    client.close()
    podium.close()


@pytest.mark.asyncio
async def test_drain_deadline_failure_is_stable_and_keeps_turns_stopped(tmp_path) -> None:
    store = ConductorStore(tmp_path)
    run = store.create_run("parent-1", "APP-1", instance_id="instance-1")
    store.start_plan(run["run_id"])
    service = ConductorService(store=store, data_root=tmp_path)
    client, podium = connected_client()
    request = DrainRequest(context("drain-timeout"), int(time.time()))

    acknowledged = await client.handle_drain(request, service)

    assert acknowledged.status == "failed"
    assert acknowledged.error_code == "workflow_result_pending"
    assert acknowledged.next_action == "retry_quit"
    assert not service.accepting_private_turns
    assert read_runtime_message(podium) == acknowledged
    client.close()
    podium.close()


@pytest.mark.asyncio
async def test_workflow_database_failure_returns_a_stable_drain_ack(
    tmp_path, monkeypatch
) -> None:
    service = ConductorService(store=ConductorStore(tmp_path), data_root=tmp_path)
    client, podium = connected_client()
    request = DrainRequest(context("drain-database"), int(time.time()) + 2)

    def fail_workflow_read() -> bool:
        raise sqlite3.DatabaseError("raw database path must not escape")

    monkeypatch.setattr(service, "_workflow_has_running_attempts", fail_workflow_read)
    acknowledged = await client.handle_drain(request, service)

    assert acknowledged.status == "failed"
    assert acknowledged.error_code == "workflow_state_unavailable"
    assert acknowledged.next_action == "inspect_workflow_db"
    assert "raw database path" not in repr(acknowledged)
    assert read_runtime_message(podium) == acknowledged
    client.close()
    podium.close()


def test_new_ipc_identity_and_client_have_no_token_url_or_header_inputs() -> None:
    parameters = {
        *inspect.signature(LocalRuntimeIdentity).parameters,
        *inspect.signature(LocalRuntimeClient.connect).parameters,
    }
    forbidden = {"token", "secret", "url", "header", "authorization", "api_key"}

    assert all(not any(term in name.lower() for term in forbidden) for name in parameters)
    source = inspect.getsource(__import__("conductor.podium_ipc", fromlist=["*"]))
    assert "PODIUM_PROXY_TOKEN" not in source
    assert "podium_runtime_token" not in source
    assert "podium_proxy_token" not in source
