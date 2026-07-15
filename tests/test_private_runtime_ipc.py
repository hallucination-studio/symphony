from __future__ import annotations

import json
import os
import subprocess
import struct
import sys

import pytest

from conductor.podium_ipc import inherited_podium_channel, send_handshake
from performer_api import LocalRuntimeEnvelope
from podium.local_sessions import PodiumLocalSession


def envelope(
    instance: str, correlation: str = "nonce-1", generation: int = 1
) -> LocalRuntimeEnvelope:
    return LocalRuntimeEnvelope(1, instance, "project-1", generation, correlation, "handshake")


def test_long_lived_podium_accepts_two_isolated_sequential_sessions() -> None:
    for instance in ("instance-1", "instance-2"):
        expected = envelope(instance, f"nonce-{instance}")
        session, child_fd = PodiumLocalSession.create(expected)
        child = inherited_podium_channel(child_fd)
        send_handshake(child, expected)
        assert session.accept() == expected
        child.close()
        session.close()


@pytest.mark.parametrize(
    "actual",
    [envelope("wrong"), envelope("instance-1", "stale"), envelope("instance-1", generation=2)],
)
def test_wrong_peer_stale_nonce_or_generation_is_rejected(actual: LocalRuntimeEnvelope) -> None:
    session, child_fd = PodiumLocalSession.create(envelope("instance-1"))
    child = inherited_podium_channel(child_fd)
    send_handshake(child, actual)
    with pytest.raises(ValueError, match="peer_mismatch"):
        session.accept()
    with pytest.raises(ValueError, match="duplicate_connect"):
        session.accept()
    child.close()
    session.close()


def test_duplicate_connect_is_rejected() -> None:
    expected = envelope("instance-1")
    session, child_fd = PodiumLocalSession.create(expected)
    child = inherited_podium_channel(child_fd)
    send_handshake(child, expected)
    session.accept()
    with pytest.raises(ValueError, match="duplicate_connect"):
        session.accept()
    child.close()
    session.close()


def test_stale_protocol_version_is_rejected() -> None:
    session, child_fd = PodiumLocalSession.create(envelope("instance-1"))
    child = inherited_podium_channel(child_fd)
    payload = envelope("instance-1").to_dict() | {"protocol_version": 2}
    body = json.dumps(payload).encode()
    child.sendall(struct.pack(">I", len(body)) + body)
    with pytest.raises(ValueError, match="protocol_version"):
        session.accept()
    child.close()
    session.close()


def test_fd_is_available_only_when_explicitly_inherited() -> None:
    session, child_fd = PodiumLocalSession.create(envelope("instance-1"))
    probe = "import os,sys; os.fstat(int(sys.argv[1]))"
    inherited = subprocess.run(
        [sys.executable, "-c", probe, str(child_fd)], pass_fds=(child_fd,)
    )
    excluded = subprocess.run([sys.executable, "-c", probe, str(child_fd)], capture_output=True)
    assert inherited.returncode == 0
    assert excluded.returncode != 0
    os.close(child_fd)
    session.close()
