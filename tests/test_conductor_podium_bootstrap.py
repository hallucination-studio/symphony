from __future__ import annotations

import os
from pathlib import Path
import signal
import subprocess
import sys

import pytest

import conductor.conductor_cli as conductor_cli
from conductor.conductor_cli import parse_args, private_bootstrap_from_args
from conductor.models import LocalRuntimeBootstrap, LocalRuntimeIdentity
from performer_api import LocalRuntimeEnvelope
from podium.local_sessions import PodiumLocalSession


def private_argv(fd: int, data_root: Path) -> list[str]:
    return [
        "--data-root",
        str(data_root),
        "--podium-ipc-fd",
        str(fd),
        "--conductor-id",
        "conductor-1",
        "--instance-id",
        "instance-1",
        "--project-id",
        "project-1",
        "--binding-id",
        "binding-1",
        "--binding-generation",
        "2",
        "--handshake-correlation-id",
        "session-1",
    ]


def expected_handshake() -> LocalRuntimeEnvelope:
    return LocalRuntimeEnvelope(
        1, "instance-1", "project-1", 2, "session-1", "handshake"
    )


def test_complete_private_arguments_build_fixed_bootstrap(tmp_path: Path) -> None:
    bootstrap = private_bootstrap_from_args(parse_args(private_argv(9, tmp_path)))

    assert bootstrap == LocalRuntimeBootstrap(
        9,
        LocalRuntimeIdentity(
            "conductor-1", "instance-1", "project-1", "binding-1", 2
        ),
        "session-1",
    )
    assert bootstrap.handshake == expected_handshake()


def test_bootstrap_rejects_secret_like_handshake_correlation() -> None:
    with pytest.raises(ValueError, match="handshake_correlation_id_invalid"):
        LocalRuntimeBootstrap(
            9,
            LocalRuntimeIdentity(
                "conductor-1", "instance-1", "project-1", "binding-1", 2
            ),
            "abcdefghij.abcdefghij.abcdefghij",
        )


@pytest.mark.parametrize(
    "argv",
    [
        ["--podium-ipc-fd", "9", "--conductor-id", "conductor-1"],
        ["--host", "127.0.0.1", *private_argv(9, Path("runtime"))],
        ["--port", "8099", *private_argv(9, Path("runtime"))],
    ],
)
def test_private_arguments_reject_partial_identity_or_public_listener(
    argv: list[str],
) -> None:
    with pytest.raises(ValueError, match="conductor_private_bootstrap_invalid"):
        private_bootstrap_from_args(parse_args(argv))


def test_subprocess_handshakes_only_over_inherited_fd_and_closes_on_signal(
    tmp_path: Path,
) -> None:
    session, child_fd = PodiumLocalSession.create(expected_handshake())
    process = subprocess.Popen(
        [sys.executable, "-m", "conductor.conductor_cli", *private_argv(child_fd, tmp_path)],
        pass_fds=(child_fd,),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    os.close(child_fd)
    try:
        assert session.accept() == expected_handshake()
        process.send_signal(signal.SIGTERM)
        stdout, stderr = process.communicate(timeout=3)
        assert process.returncode == 0, stdout + stderr
        assert session.channel.recv(1) == b""
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=3)
        session.close()


def test_unavailable_fd_fails_once_with_sanitized_correlated_log(
    tmp_path: Path,
) -> None:
    process = subprocess.run(
        [sys.executable, "-m", "conductor.conductor_cli", *private_argv(999_999, tmp_path)],
        capture_output=True,
        text=True,
        timeout=3,
    )

    assert process.returncode == 1
    assert "event=conductor_private_bootstrap_failed" in process.stderr
    assert "conductor_id=conductor-1" in process.stderr
    assert "instance_id=instance-1" in process.stderr
    assert "handshake_correlation_id=session-1" in process.stderr
    assert "error_code=podium_ipc_fd_unavailable" in process.stderr
    assert str(tmp_path) not in process.stderr
    assert not (tmp_path / "workflow.db").exists()


def test_partial_private_subprocess_exits_without_traceback(tmp_path: Path) -> None:
    process = subprocess.run(
        [
            sys.executable,
            "-m",
            "conductor.conductor_cli",
            "--data-root",
            str(tmp_path),
            "--podium-ipc-fd",
            "9",
        ],
        capture_output=True,
        text=True,
        timeout=3,
    )

    assert process.returncode == 1
    assert "error_code=conductor_private_bootstrap_invalid" in process.stderr
    assert "Traceback" not in process.stderr
    assert str(tmp_path) not in process.stderr
    assert not (tmp_path / "workflow.db").exists()


def test_private_bootstrap_surface_has_no_token_url_or_listener_fallback() -> None:
    names = {
        "podium_ipc_fd",
        "conductor_id",
        "instance_id",
        "project_id",
        "binding_id",
        "binding_generation",
        "handshake_correlation_id",
    }
    forbidden = {"token", "secret", "url", "header", "authorization", "api_key"}

    assert all(not any(term in name for term in forbidden) for name in names)
    source = Path(conductor_cli.__file__).read_text()
    assert "PODIUM_" not in source
