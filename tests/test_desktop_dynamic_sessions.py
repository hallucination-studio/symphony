from __future__ import annotations

from array import array
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import time

from conductor.podium_ipc import inherited_podium_channel, send_handshake
from performer_api import LocalRuntimeEnvelope
from podium.desktop_app import DesktopSessionHandoff
from podium.desktop_protocol import encode_frame, read_frame
from podium.local_runtime_server import LocalRuntimeServer
from podium.local_sessions import LocalSessionRegistry


def send_endpoint(
    broker: socket.socket,
    endpoint: socket.socket,
    *,
    conductor_id: str,
    instance_id: str,
    project_id: str,
    binding_id: str,
    generation: int,
    session_id: str,
    expected_pid: int,
) -> None:
    payload = json.dumps(
        {
            "protocol_version": 1,
            "conductor_id": conductor_id,
            "instance_id": instance_id,
            "project_id": project_id,
            "binding_id": binding_id,
            "binding_generation": generation,
            "session_id": session_id,
            "expected_pid": expected_pid,
        },
        separators=(",", ":"),
    ).encode()
    frame = struct.pack(">I", len(payload)) + payload
    broker.sendmsg(
        [frame],
        [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array("i", [endpoint.fileno()]))],
    )


def read_result(broker: socket.socket) -> dict[str, object]:
    size = struct.unpack(">I", broker.recv(4))[0]
    return json.loads(broker.recv(size))


def wait_for_result(broker: socket.socket) -> dict[str, object]:
    broker.settimeout(2)
    return read_result(broker)


def test_long_lived_podium_adopts_two_sequential_inherited_sessions() -> None:
    desktop, podium = socket.socketpair()
    registry = LocalSessionRegistry()
    handoff = DesktopSessionHandoff(podium, LocalRuntimeServer(registry))
    handoff.start(lambda _failure: None)
    peers: list[socket.socket] = []
    try:
        for index in (1, 2):
            podium_endpoint, conductor_endpoint = socket.socketpair()
            peers.append(conductor_endpoint)
            send_endpoint(
                desktop,
                podium_endpoint,
                conductor_id=f"conductor-{index}",
                instance_id=f"instance-{index}",
                project_id=f"project-{index}",
                binding_id=f"binding-{index}",
                generation=index,
                session_id=f"session-{index}",
                expected_pid=os.getpid() + index,
            )
            podium_endpoint.close()
            child = inherited_podium_channel(conductor_endpoint.detach())
            send_handshake(
                child,
                LocalRuntimeEnvelope(
                    1,
                    f"instance-{index}",
                    f"project-{index}",
                    index,
                    f"session-{index}",
                    "handshake",
                ),
            )
            result = wait_for_result(desktop)
            assert result == {
                "status": "accepted",
                "session_id": f"session-{index}",
            }
            assert registry.get(f"session-{index}").state == "online"
            child.close()
    finally:
        handoff.stop()
        desktop.close()
        for peer in peers:
            peer.close()


def test_duplicate_handoff_fails_closed_and_closes_transferred_endpoint() -> None:
    desktop, podium = socket.socketpair()
    registry = LocalSessionRegistry()
    handoff = DesktopSessionHandoff(podium, LocalRuntimeServer(registry))
    handoff.start(lambda _failure: None)
    try:
        first_podium, first_conductor = socket.socketpair()
        send_endpoint(
            desktop,
            first_podium,
            conductor_id="conductor-1",
            instance_id="instance-1",
            project_id="project-1",
            binding_id="binding-1",
            generation=1,
            session_id="session-1",
            expected_pid=os.getpid(),
        )
        first_podium.close()
        send_handshake(
            first_conductor,
            LocalRuntimeEnvelope(
                1,
                "instance-1",
                "project-1",
                1,
                "session-1",
                "handshake",
            ),
        )
        assert wait_for_result(desktop)["status"] == "accepted"

        duplicate_podium, duplicate_conductor = socket.socketpair()
        send_endpoint(
            desktop,
            duplicate_podium,
            conductor_id="conductor-1",
            instance_id="instance-2",
            project_id="project-2",
            binding_id="binding-2",
            generation=1,
            session_id="session-2",
            expected_pid=os.getpid(),
        )
        duplicate_podium.close()
        result = wait_for_result(desktop)
        assert result == {
            "status": "rejected",
            "session_id": "session-2",
            "error_code": "local_runtime_duplicate_process_identity",
        }
        duplicate_conductor.settimeout(1)
        assert duplicate_conductor.recv(1) == b""
        first_conductor.close()
        duplicate_conductor.close()
    finally:
        handoff.stop()
        desktop.close()


def test_replayed_session_id_fails_closed_after_the_first_session_closes() -> None:
    desktop, podium = socket.socketpair()
    registry = LocalSessionRegistry()
    handoff = DesktopSessionHandoff(podium, LocalRuntimeServer(registry))
    handoff.start(lambda _failure: None)
    try:
        first_podium, first_conductor = socket.socketpair()
        send_endpoint(
            desktop,
            first_podium,
            conductor_id="conductor-1",
            instance_id="instance-1",
            project_id="project-1",
            binding_id="binding-1",
            generation=1,
            session_id="session-1",
            expected_pid=os.getpid(),
        )
        first_podium.close()
        send_handshake(
            first_conductor,
            LocalRuntimeEnvelope(
                1, "instance-1", "project-1", 1, "session-1", "handshake"
            ),
        )
        assert wait_for_result(desktop)["status"] == "accepted"
        registry.close_all()

        replay_podium, replay_conductor = socket.socketpair()
        send_endpoint(
            desktop,
            replay_podium,
            conductor_id="conductor-2",
            instance_id="instance-2",
            project_id="project-2",
            binding_id="binding-2",
            generation=2,
            session_id="session-1",
            expected_pid=os.getpid() + 1,
        )
        replay_podium.close()
        assert wait_for_result(desktop) == {
            "status": "rejected",
            "session_id": "session-1",
            "error_code": "local_runtime_duplicate_session",
        }
        replay_conductor.settimeout(1)
        assert replay_conductor.recv(1) == b""
        first_conductor.close()
        replay_conductor.close()
    finally:
        handoff.stop()
        desktop.close()


def test_handoff_stop_is_bounded_and_closes_broker() -> None:
    desktop, podium = socket.socketpair()
    handoff = DesktopSessionHandoff(
        podium, LocalRuntimeServer(LocalSessionRegistry())
    )
    handoff.start(lambda _failure: None)

    started = time.monotonic()
    handoff.stop()

    assert time.monotonic() - started < 1
    desktop.settimeout(1)
    assert desktop.recv(1) == b""


def test_handoff_stop_is_bounded_while_transferred_session_awaits_handshake() -> None:
    desktop, podium = socket.socketpair()
    handoff = DesktopSessionHandoff(
        podium, LocalRuntimeServer(LocalSessionRegistry())
    )
    handoff.start(lambda _failure: None)
    podium_endpoint, conductor_endpoint = socket.socketpair()
    send_endpoint(
        desktop,
        podium_endpoint,
        conductor_id="conductor-1",
        instance_id="instance-1",
        project_id="project-1",
        binding_id="binding-1",
        generation=1,
        session_id="session-1",
        expected_pid=os.getpid(),
    )
    podium_endpoint.close()
    time.sleep(0.05)

    started = time.monotonic()
    handoff.stop()

    assert time.monotonic() - started < 1
    conductor_endpoint.settimeout(1)
    assert conductor_endpoint.recv(1) == b""
    conductor_endpoint.close()
    desktop.close()


def test_installed_podium_cli_accepts_two_later_sessions_without_restart(
    tmp_path: Path,
) -> None:
    desktop, podium = socket.socketpair()
    environment = {**os.environ, "PODIUM_DATA_ROOT": str(tmp_path / "podium")}
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "podium.desktop_cli",
            "--desktop-ipc-fd",
            str(podium.fileno()),
        ],
        pass_fds=(podium.fileno(),),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
    )
    podium.close()
    try:
        for index in (1, 2):
            podium_endpoint, conductor_endpoint = socket.socketpair()
            send_endpoint(
                desktop,
                podium_endpoint,
                conductor_id=f"conductor-{index}",
                instance_id=f"instance-{index}",
                project_id=f"project-{index}",
                binding_id=f"binding-{index}",
                generation=1,
                session_id=f"session-{index}",
                expected_pid=os.getpid() + index,
            )
            podium_endpoint.close()
            send_handshake(
                conductor_endpoint,
                LocalRuntimeEnvelope(
                    1,
                    f"instance-{index}",
                    f"project-{index}",
                    1,
                    f"session-{index}",
                    "handshake",
                ),
            )
            assert wait_for_result(desktop)["status"] == "accepted"
            conductor_endpoint.close()

        assert process.stdin is not None and process.stdout is not None
        process.stdin.write(
            encode_frame(
                {
                    "kind": "shutdown",
                    "request_id": "desktop-stop",
                    "protocol_version": 1,
                }
            )
        )
        process.stdin.flush()
        response = read_frame(process.stdout)
        assert response is not None and response["status"] == "stopping"
        assert process.wait(timeout=3) == 0
    finally:
        desktop.close()
        if process.poll() is None:
            process.kill()
            process.wait(timeout=3)
