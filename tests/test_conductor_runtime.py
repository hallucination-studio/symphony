from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

from conductor.runtime import PerformerRuntime, StaleRuntimeResult
from performer_api.turns import TurnContext


def test_runtime_prepares_fixed_process_context_without_materializing_codex_home(tmp_path, monkeypatch) -> None:
    home = tmp_path / "home"
    codex_home = tmp_path / "codex"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    monkeypatch.setenv("PATH", "/approved/bin")
    monkeypatch.setenv("LANG", "en_US.UTF-8")
    monkeypatch.setenv("LC_ALL", "C.UTF-8")
    monkeypatch.setenv("TMPDIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("CODEX_SDK_CODEX_BIN", "/approved/bin/codex")
    monkeypatch.setenv("CODEX_MODEL", "ambient-policy-must-not-pass")
    monkeypatch.setenv("PODIUM_PROXY_TOKEN", "podium-secret")

    runtime = PerformerRuntime()
    environment = runtime.prepare_environment()

    assert environment == {
        "HOME": str(home),
        "CODEX_HOME": str(codex_home),
        "PATH": "/approved/bin",
        "LANG": "en_US.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TMPDIR": str(tmp_path / "tmp"),
        "CODEX_SDK_CODEX_BIN": "/approved/bin/codex",
    }
    assert not codex_home.exists()
    environment["HOME"] = "/mutated"
    assert runtime.prepare_environment()["HOME"] == str(home)
    with pytest.raises(TypeError):
        runtime.process_env["HOME"] = "/mutated"  # type: ignore[index]


def test_runtime_fixed_process_context_allows_missing_codex_home(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.delenv("CODEX_HOME", raising=False)

    environment = PerformerRuntime().prepare_environment()

    assert environment["HOME"] == str(tmp_path / "home")
    assert "CODEX_HOME" not in environment


def test_runtime_resolves_performer_from_python_environment_when_path_is_missing(tmp_path, monkeypatch) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    python = bin_dir / "python"
    performer = bin_dir / "performer"
    python.write_text("", encoding="utf-8")
    performer.write_text("", encoding="utf-8")
    performer.chmod(0o755)

    monkeypatch.setattr("conductor.runtime.sys.executable", str(python))

    assert PerformerRuntime().performer_command == (str(performer),)


def test_runtime_resolves_performer_next_to_conductor_launcher_when_python_is_host_interpreter(tmp_path, monkeypatch) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    conductor = bin_dir / "conductor"
    performer = bin_dir / "performer"
    conductor.write_text("#!/bin/sh\n", encoding="utf-8")
    performer.write_text("#!/bin/sh\n", encoding="utf-8")
    conductor.chmod(0o755)
    performer.chmod(0o755)

    monkeypatch.setattr("conductor.runtime.sys.argv", [str(conductor)])
    monkeypatch.setattr("conductor.runtime.sys.executable", "/usr/bin/python3")

    assert PerformerRuntime().performer_command == (str(performer),)


def test_runtime_rejects_stale_fenced_result() -> None:
    expected = TurnContext("run-1", "task-1", "attempt-1", 3, "execute")
    stale = {"context": {**expected.to_dict(), "fencing_token": 2}}

    with pytest.raises(StaleRuntimeResult, match="stale_fencing_token"):
        PerformerRuntime.accept_result(expected, stale)


def test_runtime_writes_sanitized_instance_log_events(tmp_path) -> None:
    runtime = PerformerRuntime()
    log_path = tmp_path / "conductor.log"

    runtime.append_event(log_path, "event=performer_turn_started token=secret-value")
    runtime.append_event(log_path, "event=performer_turn_completed authorization: Bearer secret-value")

    logs = runtime.read_log(log_path, tail=1, order="desc")
    assert logs["lines"] == ["event=performer_turn_completed authorization: [REDACTED]"]
    assert "secret-value" not in logs["logs"]


def test_runtime_does_not_forward_parent_credentials_to_performer(tmp_path, monkeypatch) -> None:
    runtime = PerformerRuntime(
        performer_command=("performer",),
        process_env={
            "HOME": str(tmp_path / "home"),
            "CODEX_HOME": str(tmp_path / "codex"),
            "CODEX_MODEL": "gpt-5.4",
            "PODIUM_LINEAR_APP_ACCESS_TOKEN": "linear-secret",
            "PODIUM_PROXY_TOKEN": "podium-secret",
            "LINEAR_API_KEY": "linear-api-secret",
        },
    )
    paths = runtime.paths(tmp_path / "attempt")
    paths.request.write_text("{}", encoding="utf-8")
    captured: dict[str, object] = {}

    def fake_run(command, *, env, capture_output, text, check, timeout):
        captured["command"] = command
        captured["env"] = env
        paths.result.write_text(json.dumps({"context": {}}), encoding="utf-8")
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setenv("PODIUM_LINEAR_APP_ACCESS_TOKEN", "linear-secret")
    monkeypatch.setenv("PODIUM_PROXY_TOKEN", "podium-secret")
    monkeypatch.setenv("LINEAR_API_KEY", "linear-api-secret")
    monkeypatch.setattr("conductor.runtime.subprocess.run", fake_run)

    runtime.run(paths)

    process_env = captured["env"]
    assert process_env["HOME"] == str(tmp_path / "home")
    assert process_env["CODEX_HOME"] == str(tmp_path / "codex")
    assert "CODEX_MODEL" not in process_env
    assert "PODIUM_LINEAR_APP_ACCESS_TOKEN" not in process_env
    assert "PODIUM_PROXY_TOKEN" not in process_env
    assert "LINEAR_API_KEY" not in process_env


def test_runtime_does_not_forward_codex_config_overrides(tmp_path, monkeypatch) -> None:
    runtime = PerformerRuntime(
        performer_command=("performer",),
        process_env={
            "HOME": str(tmp_path / "home"),
            "CODEX_CONFIG_OVERRIDES": "model='attacker'",
        },
    )
    paths = runtime.paths(tmp_path / "attempt")
    paths.request.write_text("{}", encoding="utf-8")
    captured: dict[str, object] = {}

    def fake_run(command, *, env, capture_output, text, check, timeout):
        captured["env"] = env
        paths.result.write_text(json.dumps({"context": {}}), encoding="utf-8")
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setenv("CODEX_CONFIG_OVERRIDES", "model='attacker'")
    monkeypatch.setattr("conductor.runtime.subprocess.run", fake_run)

    runtime.run(paths)

    assert "CODEX_CONFIG_OVERRIDES" not in captured["env"]


def test_runtime_process_timeout_comes_from_request_execution_policy(tmp_path, monkeypatch) -> None:
    runtime = PerformerRuntime(
        performer_command=("performer",),
        process_env={"HOME": str(tmp_path / "home")},
    )
    paths = runtime.paths(tmp_path / "attempt")
    paths.request.write_text(
        json.dumps({"execution_policy": {"turn_timeout_ms": 12_000}}),
        encoding="utf-8",
    )
    captured: dict[str, object] = {}

    def fake_run(command, *, env, capture_output, text, check, timeout):
        captured["timeout"] = timeout
        paths.result.write_text("{}", encoding="utf-8")
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setattr("conductor.runtime.subprocess.run", fake_run)

    runtime.run(paths)

    assert captured["timeout"] == 42.0


@pytest.mark.asyncio
async def test_runtime_async_cancellation_waits_for_performer_exit(tmp_path) -> None:
    pid_path = tmp_path / "performer.pid"
    late_mutation = tmp_path / "late-mutation"
    script = tmp_path / "slow-performer.py"
    script.write_text(
        "\n".join(
            (
                "import os",
                "from pathlib import Path",
                "import time",
                f"Path({str(pid_path)!r}).write_text(str(os.getpid()), encoding='utf-8')",
                "time.sleep(5)",
                f"Path({str(late_mutation)!r}).write_text('late', encoding='utf-8')",
            )
        ),
        encoding="utf-8",
    )
    runtime = PerformerRuntime(
        performer_command=(sys.executable, str(script)),
        process_env={"HOME": str(tmp_path / "home")},
    )
    paths = runtime.paths(tmp_path / "attempt")
    paths.request.write_text("{}", encoding="utf-8")

    running = asyncio.create_task(runtime.run_async(paths))
    for _ in range(100):
        if pid_path.exists():
            break
        await asyncio.sleep(0.01)
    assert pid_path.exists()
    pid = int(pid_path.read_text(encoding="utf-8"))

    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running

    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
    await asyncio.sleep(0.05)
    assert not late_mutation.exists()


def test_runtime_sanitizes_performer_stdout_and_stderr_before_persisting(tmp_path, monkeypatch) -> None:
    runtime = PerformerRuntime(process_env={"HOME": str(tmp_path / "home")})
    paths = runtime.paths(tmp_path / "attempt")

    def fake_run(*_args, **_kwargs):
        paths.result.write_text("{}", encoding="utf-8")
        return SimpleNamespace(
            returncode=0,
            stdout="Authorization: Bearer stdout-secret\n",
            stderr="token=stderr-secret\n",
        )

    monkeypatch.setattr("conductor.runtime.subprocess.run", fake_run)

    runtime.run(paths)

    log_text = paths.log.read_text(encoding="utf-8")
    assert "stdout-secret" not in log_text
    assert "stderr-secret" not in log_text
    assert "Authorization: [REDACTED]" in log_text
    assert "token=[REDACTED]" in log_text


def test_runtime_redacts_auth_paths_and_jwt_like_values(tmp_path) -> None:
    runtime = PerformerRuntime()
    log_path = tmp_path / "conductor.log"
    jwt = "eyJ" + "a" * 24 + "." + "b" * 16 + "." + "c" * 16

    runtime.append_event(log_path, f"path=/tmp/.codex/auth.json jwt={jwt}")

    logs = runtime.read_log(log_path, order="asc")["logs"]
    assert "auth.json" not in logs
    assert jwt not in logs
    assert "[REDACTED_PATH]" in logs
    assert "[REDACTED]" in logs


def test_runtime_preserves_sanitized_performer_failure_reason(tmp_path, monkeypatch) -> None:
    runtime = PerformerRuntime(process_env={"HOME": str(tmp_path / "home")})
    paths = runtime.paths(tmp_path / "attempt")

    def fake_run(*_args, **_kwargs):
        return SimpleNamespace(
            returncode=1,
            stdout="performer startup failed: upstream_overloaded_exhausted:http_status=502 token=secret-value\n",
            stderr="",
        )

    monkeypatch.setattr("conductor.runtime.subprocess.run", fake_run)

    with pytest.raises(RuntimeError, match=r"performer_failed:exit_1:upstream_overloaded_exhausted:http_status=502 token=\[REDACTED\]"):
        runtime.run(paths)
