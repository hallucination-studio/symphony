from __future__ import annotations

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import subprocess
import threading
import time
from typing import Iterator
from uuid import uuid4

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse
import pytest

from podium.podium_install import render_install_script
from podium.podium_routes_runtime_enrollment import _register_onboarding_enrollment_route


@contextmanager
def _fake_podium(
    enrollments: dict[str, dict[str, str]],
    calls: list[str] | None = None,
) -> Iterator[str]:
    observed_calls = calls if calls is not None else []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if self.path != "/install.sh":
                self.send_error(404)
                return
            body = render_install_script().encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/x-shellscript")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/api/v1/runtime/enroll":
                self.send_error(404)
                return
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length))
            enrollment_token = str(payload["enrollment_token"])
            observed_calls.append(enrollment_token)
            response = enrollments[enrollment_token]
            body = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _write_fake_conductor(path: Path) -> None:
    path.write_text(
        """#!/usr/bin/env python3
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import os

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--data-root", type=Path, required=True)
args = parser.parse_args()
args.data_root.mkdir(parents=True, exist_ok=True)
(args.data_root / "fake-conductor.pid").write_text(str(os.getpid()), encoding="utf-8")
(args.data_root / "fake-conductor.port").write_text(str(args.port), encoding="utf-8")
(args.data_root / "secret-env-keys.json").write_text(
    json.dumps(sorted(key for key in (
        "PODIUM_ENROLLMENT_TOKEN",
        "PODIUM_RUNTIME_TOKEN",
        "PODIUM_PROXY_TOKEN",
        "ENROLLMENT_TOKEN",
        "ENROLLED_JSON",
        "RUNTIME_TOKEN",
        "PROXY_TOKEN",
    ) if key in os.environ)),
    encoding="utf-8",
)
print(f"fake_conductor_started data_root={args.data_root} port={args.port}", flush=True)

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()

    def do_PATCH(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        (args.data_root / "settings.json").write_bytes(body)
        self.send_response(200)
        self.end_headers()

    def log_message(self, _format, *_args):
        return

ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
""",
        encoding="utf-8",
    )
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def _write_installer(path: Path) -> None:
    path.write_text(render_install_script(), encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def _enrollment_app(runtime_ids: list[str], podium_base_url: str) -> FastAPI:
    class State:
        def __init__(self) -> None:
            self.index = 0
            self.conductors: dict[str, dict[str, str]] = {}

        async def reserve_conductor(self, _workspace_id: str, name: str) -> dict[str, str]:
            conductor_record = {"id": runtime_ids[self.index], "name": name}
            self.index += 1
            self.conductors[str(conductor_record["id"])] = conductor_record
            return conductor_record

        async def conductor_for_user(
            self,
            conductor_id: str,
            _workspace_id: str,
        ) -> dict[str, str] | None:
            return self.conductors.get(conductor_id)

        async def save_enrollment_token(self, *_args: object, **_kwargs: object) -> None:
            return None

        async def conductor_public(self, conductor_record: dict[str, str]) -> dict[str, str]:
            return conductor_record

    async def require_user(_request: object) -> dict[str, str]:
        return {"id": "workspace-1"}

    def error_response(status: int, code: str, message: str) -> JSONResponse:
        return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)

    state = State()
    app = FastAPI()
    app.state.enrollment_test_state = state
    _register_onboarding_enrollment_route(
        app,
        state=state,
        require_user=require_user,
        podium_base_url=podium_base_url,
        error_response=error_response,
    )
    return app


def _run_installer(
    installer: Path,
    conductor: Path,
    podium_url: str,
    *,
    home: Path,
    enrollment_token: str,
    arguments: list[str] | None = None,
    environment: dict[str, str] | None = None,
    xtrace: bool = False,
) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "HOME": str(home),
        "PODIUM_ENROLLMENT_TOKEN": enrollment_token,
        "PODIUM_CONDUCTOR_COMMAND": str(conductor),
        "PYTHONUNBUFFERED": "1",
        **(environment or {}),
    }
    command = ["bash", "-x", str(installer)] if xtrace else [str(installer)]
    return subprocess.run(
        [*command, "--podium-url", podium_url, *(arguments or [])],
        check=False,
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )


def _run_generated_command(
    command: str,
    conductor: Path,
    *,
    home: Path,
    environment: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-c", command],
        check=False,
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "HOME": str(home),
            "PODIUM_CONDUCTOR_COMMAND": str(conductor),
            "PYTHONUNBUFFERED": "1",
            **(environment or {}),
        },
        timeout=30,
    )


def _runtime_response(runtime_id: str, suffix: str) -> dict[str, str]:
    return {
        "runtime_id": runtime_id,
        "runtime_token": f"runtime-token-{suffix}",
        "proxy_token": f"proxy-token-{suffix}",
    }


def _port_from_stdout(stdout: str) -> int:
    match = re.search(r"Conductor API: http://127\.0\.0\.1:(\d+)", stdout)
    assert match is not None, stdout
    return int(match.group(1))


def _terminate_fake_conductors(home: Path) -> None:
    for pid_path in home.rglob("fake-conductor.pid"):
        try:
            os.kill(int(pid_path.read_text(encoding="utf-8")), signal.SIGTERM)
        except (ProcessLookupError, ValueError):
            pass


def _wait_for_exit(pid: int) -> None:
    for _ in range(50):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.02)


def _available_port() -> int:
    with socket.socket() as candidate:
        candidate.bind(("127.0.0.1", 0))
        return int(candidate.getsockname()[1])


def _wait_until_listening(port: int) -> None:
    for _ in range(100):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                return
        except OSError:
            time.sleep(0.02)
    raise AssertionError(f"fake Conductor did not listen on port {port}")


@pytest.mark.anyio
async def test_two_generated_install_commands_are_isolated_and_do_not_print_secrets(tmp_path: Path) -> None:
    conductor = tmp_path / "fake-conductor"
    home = tmp_path / "home"
    home.mkdir()
    _write_fake_conductor(conductor)
    runtime_ids = [f"runtime-{uuid4().hex}", f"runtime-{uuid4().hex}"]
    enrollments: dict[str, dict[str, str]] = {}
    log_paths = [Path(f"/tmp/podium-conductor-{runtime_id}.log") for runtime_id in runtime_ids]
    for log_path in log_paths:
        log_path.unlink(missing_ok=True)

    processes: list[subprocess.CompletedProcess[str]] = []
    try:
        with _fake_podium(enrollments) as podium_url:
            app = _enrollment_app(runtime_ids, podium_url)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://test",
            ) as client:
                generated = [
                    (
                        await client.post(
                            "/api/v1/onboarding/runtime/enrollment-token",
                            json={"name": name},
                        )
                    ).json()
                    for name in ("First", "Second")
                ]
            enrollment_tokens = [str(entry["enrollment_token"]) for entry in generated]
            enrollments.update(
                {
                    enrollment_tokens[0]: _runtime_response(runtime_ids[0], "one"),
                    enrollment_tokens[1]: _runtime_response(runtime_ids[1], "two"),
                }
            )
            for entry in generated:
                processes.append(
                    _run_generated_command(
                        str(entry["install_command"]),
                        conductor,
                        home=home,
                        environment={
                            "PODIUM_RUNTIME_TOKEN": "inherited-podium-runtime-secret",
                            "PODIUM_PROXY_TOKEN": "inherited-podium-proxy-secret",
                            "ENROLLMENT_TOKEN": "inherited-enrollment-secret",
                            "ENROLLED_JSON": "inherited-secret-json",
                            "RUNTIME_TOKEN": "inherited-runtime-secret",
                            "PROXY_TOKEN": "inherited-proxy-secret",
                        },
                    )
                )

        assert [process.returncode for process in processes] == [0, 0]
        settings_paths = list(home.rglob("settings.json"))
        settings_by_runtime = {
            json.loads(path.read_text(encoding="utf-8"))["podium_runtime_id"]: path
            for path in settings_paths
        }
        data_roots = [settings_by_runtime[runtime_id].parent for runtime_id in runtime_ids]
        assert data_roots[0] != data_roots[1]
        settings = [
            json.loads((data_root / "settings.json").read_text(encoding="utf-8"))
            for data_root in data_roots
        ]
        assert [entry["podium_runtime_id"] for entry in settings] == runtime_ids
        assert [entry["conductor_id"] for entry in settings] == runtime_ids
        assert [
            json.loads((data_root / "secret-env-keys.json").read_text(encoding="utf-8"))
            for data_root in data_roots
        ] == [[], []]
        ports = [_port_from_stdout(process.stdout) for process in processes]
        assert ports[0] != ports[1]
        assert [
            int((root / "fake-conductor.port").read_text(encoding="utf-8"))
            for root in data_roots
        ] == ports
        assert all(log_path.is_file() for log_path in log_paths)
        assert not log_paths[0].samefile(log_paths[1])

        secret_values = [
            *enrollment_tokens,
            "runtime-token-one",
            "runtime-token-two",
            "proxy-token-one",
            "proxy-token-two",
            "inherited-podium-runtime-secret",
            "inherited-podium-proxy-secret",
            "inherited-enrollment-secret",
            "inherited-secret-json",
            "inherited-runtime-secret",
            "inherited-proxy-secret",
            '"runtime_token"',
            '"proxy_token"',
        ]
        visible_output = "\n".join(
            [
                *(process.stdout + process.stderr for process in processes),
                *(path.read_text(encoding="utf-8") for path in log_paths),
            ]
        )
        assert all(secret not in visible_output for secret in secret_values)
    finally:
        pids = [
            int(path.read_text(encoding="utf-8"))
            for path in home.rglob("fake-conductor.pid")
            if path.is_file()
        ]
        _terminate_fake_conductors(home)
        for pid in pids:
            _wait_for_exit(pid)
        for log_path in log_paths:
            log_path.unlink(missing_ok=True)


def test_explicit_data_root_and_port_overrides_are_authoritative(tmp_path: Path) -> None:
    installer = tmp_path / "install.sh"
    conductor = tmp_path / "fake-conductor"
    home = tmp_path / "home"
    home.mkdir()
    _write_installer(installer)
    _write_fake_conductor(conductor)
    runtime_id = f"runtime-{uuid4().hex}"
    enrollment_token = f"enrollment-token-{uuid4().hex}"
    explicit_root = tmp_path / "chosen-root"
    explicit_port = _available_port()
    log_path = Path(f"/tmp/podium-conductor-{runtime_id}.log")
    log_path.unlink(missing_ok=True)

    try:
        with _fake_podium({enrollment_token: _runtime_response(runtime_id, "explicit")}) as podium_url:
            process = _run_installer(
                installer,
                conductor,
                podium_url,
                home=home,
                enrollment_token=enrollment_token,
                arguments=["--data-root", str(explicit_root), "--port", str(explicit_port)],
                environment={
                    "PODIUM_CONDUCTOR_DATA_ROOT": str(tmp_path / "ignored-root"),
                    "PODIUM_CONDUCTOR_PORT": "not-a-port",
                },
                xtrace=True,
            )

        assert process.returncode == 0, process.stderr
        assert (explicit_root / "settings.json").is_file()
        assert int((explicit_root / "fake-conductor.port").read_text(encoding="utf-8")) == explicit_port
        assert _port_from_stdout(process.stdout) == explicit_port
        assert not (home / ".podium-conductors" / runtime_id).exists()
        visible_output = process.stdout + process.stderr + log_path.read_text(encoding="utf-8")
        assert enrollment_token not in visible_output
        assert "runtime-token-explicit" not in visible_output
        assert "proxy-token-explicit" not in visible_output
    finally:
        _terminate_fake_conductors(home)
        _terminate_fake_conductors(tmp_path)
        log_path.unlink(missing_ok=True)


def test_no_start_configures_an_existing_conductor_on_its_listening_port(tmp_path: Path) -> None:
    installer = tmp_path / "install.sh"
    conductor = tmp_path / "fake-conductor"
    home = tmp_path / "home"
    data_root = tmp_path / "existing-root"
    home.mkdir()
    _write_installer(installer)
    _write_fake_conductor(conductor)
    port = _available_port()
    existing = subprocess.Popen(
        [str(conductor), "--port", str(port), "--data-root", str(data_root)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    runtime_id = f"runtime-{uuid4().hex}"
    enrollment_token = f"enrollment-token-{uuid4().hex}"

    try:
        _wait_until_listening(port)
        with _fake_podium({enrollment_token: _runtime_response(runtime_id, "existing")}) as podium_url:
            process = _run_installer(
                installer,
                conductor,
                podium_url,
                home=home,
                enrollment_token=enrollment_token,
                arguments=[
                    "--no-start",
                    "--data-root",
                    str(data_root),
                    "--port",
                    str(port),
                ],
            )

        assert process.returncode == 0, process.stderr
        settings = json.loads((data_root / "settings.json").read_text(encoding="utf-8"))
        assert settings["podium_runtime_id"] == runtime_id
        assert settings["conductor_id"] == runtime_id
        assert _port_from_stdout(process.stdout) == port
    finally:
        existing.terminate()
        existing.wait(timeout=5)


@pytest.mark.parametrize(
    "arguments",
    [
        ["--port", "not-a-port"],
        ["--port", "0"],
        ["--port", "65536"],
        ["--port", ""],
        ["--port"],
    ],
)
def test_invalid_explicit_port_fails_before_enrollment(
    tmp_path: Path,
    arguments: list[str],
) -> None:
    installer = tmp_path / "install.sh"
    conductor = tmp_path / "fake-conductor"
    home = tmp_path / "home"
    home.mkdir()
    _write_installer(installer)
    invalid_token = f"enrollment-token-{uuid4().hex}"
    enrollment_calls: list[str] = []

    with _fake_podium(
        {invalid_token: _runtime_response(f"runtime-{uuid4().hex}", "invalid")},
        enrollment_calls,
    ) as podium_url:
        invalid = _run_installer(
            installer,
            conductor,
            podium_url,
            home=home,
            enrollment_token=invalid_token,
            arguments=arguments,
        )

    assert invalid.returncode == 2
    assert "Conductor port must be an integer between 1 and 65535" in invalid.stderr
    assert enrollment_calls == []


@pytest.mark.parametrize("arguments", [["--data-root", ""], ["--data-root"]])
def test_invalid_explicit_data_root_fails_before_enrollment(
    tmp_path: Path,
    arguments: list[str],
) -> None:
    installer = tmp_path / "install.sh"
    conductor = tmp_path / "fake-conductor"
    home = tmp_path / "home"
    home.mkdir()
    _write_installer(installer)
    enrollment_token = f"enrollment-token-{uuid4().hex}"
    enrollment_calls: list[str] = []

    with _fake_podium(
        {enrollment_token: _runtime_response(f"runtime-{uuid4().hex}", "invalid-root")},
        enrollment_calls,
    ) as podium_url:
        invalid = _run_installer(
            installer,
            conductor,
            podium_url,
            home=home,
            enrollment_token=enrollment_token,
            arguments=arguments,
            environment={"PODIUM_START_CONDUCTOR": "0"},
        )

    assert invalid.returncode == 2
    assert invalid.stderr.strip() == "Conductor data root must not be empty"
    assert enrollment_calls == []


def test_unavailable_explicit_port_fails_before_enrollment(tmp_path: Path) -> None:
    installer = tmp_path / "install.sh"
    conductor = tmp_path / "fake-conductor"
    home = tmp_path / "home"
    home.mkdir()
    _write_installer(installer)
    enrollment_token = f"enrollment-token-{uuid4().hex}"
    enrollment_calls: list[str] = []

    with _fake_podium(
        {enrollment_token: _runtime_response(f"runtime-{uuid4().hex}", "unavailable")},
        enrollment_calls,
    ) as podium_url:
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            unavailable_port = int(occupied.getsockname()[1])
            unavailable = _run_installer(
                installer,
                conductor,
                podium_url,
                home=home,
                enrollment_token=enrollment_token,
                arguments=["--port", str(unavailable_port)],
            )

    assert unavailable.returncode == 2
    assert f"Conductor port {unavailable_port} is unavailable" in unavailable.stderr
    assert enrollment_calls == []


@pytest.mark.anyio
async def test_generated_command_quotes_the_configured_podium_url() -> None:
    podium_url = "https://podium.example/path with spaces;do-not-run"
    app = _enrollment_app(["runtime-1"], podium_url)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.post(
            "/api/v1/onboarding/runtime/enrollment-token",
            json={"name": "Quoted"},
        )

    assert response.status_code == 200
    command = response.json()["install_command"]
    assert f"curl -fsSL '{podium_url}/install.sh'" in command
    assert f"--podium-url '{podium_url}'" in command


@pytest.mark.anyio
async def test_regenerated_command_reuses_the_reserved_conductor_identity() -> None:
    app = _enrollment_app(["runtime-1", "runtime-2"], "https://podium.example")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        created = await client.post(
            "/api/v1/onboarding/runtime/enrollment-token",
            json={"name": "First"},
        )
        regenerated = await client.post(
            "/api/v1/onboarding/runtime/enrollment-token",
            json={"conductor_id": "runtime-1"},
        )
        second = await client.post(
            "/api/v1/onboarding/runtime/enrollment-token",
            json={"name": "Second"},
        )

    assert created.status_code == 200
    assert regenerated.status_code == 200
    assert second.status_code == 200
    assert created.json()["conductor"]["id"] == "runtime-1"
    assert regenerated.json()["conductor"]["id"] == "runtime-1"
    assert second.json()["conductor"]["id"] == "runtime-2"
    assert regenerated.json()["enrollment_token"] != created.json()["enrollment_token"]
    assert regenerated.headers["cache-control"] == "no-store"


@pytest.mark.anyio
async def test_regeneration_rejects_ambiguous_unknown_and_enrolled_identities() -> None:
    app = _enrollment_app(["runtime-1"], "https://podium.example")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        ambiguous = await client.post(
            "/api/v1/onboarding/runtime/enrollment-token",
            json={"name": "First", "conductor_id": "runtime-1"},
        )
        unknown = await client.post(
            "/api/v1/onboarding/runtime/enrollment-token",
            json={"conductor_id": "missing"},
        )
        await client.post(
            "/api/v1/onboarding/runtime/enrollment-token",
            json={"name": "First"},
        )
        app.state.enrollment_test_state.conductors["runtime-1"]["enrollment_state"] = "enrolled"
        enrolled = await client.post(
            "/api/v1/onboarding/runtime/enrollment-token",
            json={"conductor_id": "runtime-1"},
        )

    assert ambiguous.status_code == 400
    assert ambiguous.json()["error"]["code"] == "invalid_enrollment_request"
    assert unknown.status_code == 404
    assert unknown.json()["error"]["code"] == "conductor_not_found"
    assert enrolled.status_code == 409
    assert enrolled.json()["error"]["code"] == "conductor_already_enrolled"


def test_unknown_option_does_not_echo_untrusted_input(tmp_path: Path) -> None:
    installer = tmp_path / "install.sh"
    conductor = tmp_path / "fake-conductor"
    home = tmp_path / "home"
    home.mkdir()
    _write_installer(installer)
    sentinel = f"secret-{uuid4().hex}"

    process = _run_installer(
        installer,
        conductor,
        "http://127.0.0.1:1",
        home=home,
        enrollment_token=f"enrollment-token-{uuid4().hex}",
        arguments=[f"--{sentinel}"],
    )

    assert process.returncode == 2
    assert process.stderr.strip() == "Unknown installer option"
    assert sentinel not in process.stderr
