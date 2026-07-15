from __future__ import annotations

import os

import pytest

from conductor.podium_ipc import inherited_podium_channel, send_handshake
from performer_api import LocalRuntimeEnvelope
from podium.desktop_app import DesktopLifecycle
from podium.local_runtime_server import LocalRuntimeServer
from podium.local_sessions import LocalSessionIdentity, LocalSessionRegistry


def identity(generation: int = 1, *, pid: int = 4100) -> LocalSessionIdentity:
    return LocalSessionIdentity(
        conductor_id="conductor-1",
        project_id="project-1",
        binding_id="binding-1",
        binding_generation=generation,
        instance_id="instance-1",
        expected_pid=pid,
    )


def test_registry_accepts_only_the_expected_process_and_handshake() -> None:
    registry = LocalSessionRegistry()
    server = LocalRuntimeServer(registry)
    pending, child_fd = server.open(identity())
    child = inherited_podium_channel(child_fd)
    send_handshake(child, pending.expected)

    record = server.accept(pending.session_id, peer_pid=4100)

    assert record.identity == identity()
    assert record.state == "online"
    assert registry.active_for_binding("binding-1") == record
    child.close()
    server.close_all()


@pytest.mark.parametrize(
    "peer_pid,generation,error",
    [
        (4101, 1, "local_runtime_wrong_process"),
        (4100, 2, "local_runtime_stale_generation"),
    ],
)
def test_wrong_process_or_stale_generation_is_closed(
    peer_pid: int, generation: int, error: str
) -> None:
    server = LocalRuntimeServer(LocalSessionRegistry())
    pending, child_fd = server.open(identity())
    child = inherited_podium_channel(child_fd)
    send_handshake(child, pending.expected)

    with pytest.raises(ValueError, match=error):
        server.accept(
            pending.session_id, peer_pid=peer_pid, binding_generation=generation
        )
    assert server.registry.get(pending.session_id).state == "closed"
    with pytest.raises(ValueError, match="local_runtime_session_closed"):
        server.accept(pending.session_id, peer_pid=4100)
    child.close()
    server.close_all()


def test_duplicate_binding_and_replayed_session_are_rejected() -> None:
    server = LocalRuntimeServer(LocalSessionRegistry())
    pending, child_fd = server.open(identity())
    child = inherited_podium_channel(child_fd)
    send_handshake(child, pending.expected)
    server.accept(pending.session_id, peer_pid=4100)

    with pytest.raises(ValueError, match="local_runtime_duplicate_binding"):
        server.open(identity(pid=4101))
    with pytest.raises(ValueError, match="local_runtime_duplicate_connect"):
        server.accept(pending.session_id, peer_pid=4100)
    child.close()
    server.close_all()


@pytest.mark.parametrize(
    "duplicate",
    [
        LocalSessionIdentity(
            "conductor-2", "project-2", "binding-2", 1, "instance-2", 4100
        ),
        LocalSessionIdentity(
            "conductor-2", "project-2", "binding-2", 1, "instance-1", 4101
        ),
        LocalSessionIdentity(
            "conductor-1", "project-2", "binding-2", 1, "instance-2", 4101
        ),
    ],
)
def test_active_process_identity_cannot_be_shared_across_bindings(
    duplicate: LocalSessionIdentity,
) -> None:
    server = LocalRuntimeServer(LocalSessionRegistry())
    pending, child_fd = server.open(identity())

    with pytest.raises(ValueError, match="local_runtime_duplicate_process_identity"):
        server.open(duplicate)

    os.close(child_fd)
    server.close_all()


@pytest.mark.parametrize(
    "value",
    [
        "line\nbreak",
        "x" * 201,
        "sk-abcdefghijklmnopqrstuvwxyz123456",
        "abcdefghij.abcdefghij.abcdefghij",
        "conductor:sk-abcdefghijklmnopqrstuvwxyz123456",
        "id:abcdefghij.abcdefghij.abcdefghij",
    ],
)
def test_identity_rejects_unbounded_log_or_secret_material(value: str) -> None:
    with pytest.raises(ValueError, match="conductor_id is invalid"):
        LocalSessionIdentity(value, "project-1", "binding-1", 1, "instance-1", 4100)


def test_process_exit_marks_session_offline_without_persisting_secrets() -> None:
    server = LocalRuntimeServer(LocalSessionRegistry())
    pending, child_fd = server.open(identity())
    child = inherited_podium_channel(child_fd)
    send_handshake(child, pending.expected)
    server.accept(pending.session_id, peer_pid=4100)

    record = server.process_exited(4100)

    assert record.state == "offline"
    assert registry_values(record) == {
        "session_id": record.session_id,
        "conductor_id": "conductor-1",
        "project_id": "project-1",
        "binding_id": "binding-1",
        "binding_generation": 1,
        "instance_id": "instance-1",
        "expected_pid": 4100,
        "state": "offline",
    }
    with pytest.raises(ValueError, match="local_runtime_session_offline"):
        server.accept(pending.session_id, peer_pid=4100)
    child.close()
    server.close_all()


def test_desktop_shutdown_closes_runtime_sessions(tmp_path) -> None:
    server = LocalRuntimeServer(LocalSessionRegistry())
    lifecycle = DesktopLifecycle(tmp_path, local_runtime_server=server)
    lifecycle.start()
    pending, child_fd = server.open(identity(pid=os.getpid()))

    lifecycle.shutdown()

    assert server.registry.get(pending.session_id).state == "closed"
    os.close(child_fd)


def registry_values(record) -> dict[str, object]:
    return {
        "session_id": record.session_id,
        **record.identity.to_dict(),
        "state": record.state,
    }
