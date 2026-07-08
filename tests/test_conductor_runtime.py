from __future__ import annotations

import asyncio
import inspect
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from conductor.conductor_models import InstanceRecord
from conductor.conductor_runtime import ConductorRuntimeManager, LogQuery, RuntimeHandle


class FakeStream:
    def __init__(self, chunks: list[bytes]):
        self.chunks = chunks

    async def readline(self) -> bytes:
        await asyncio.sleep(0)
        if not self.chunks:
            return b""
        return self.chunks.pop(0)


class FakeProcess:
    def __init__(self, pid: int = 4242) -> None:
        self.pid = pid
        self.stdout = FakeStream([b"daemon started\n"])
        self.stderr = FakeStream([b"warning line\n"])
        self.returncode: int | None = None
        self.terminated = False

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = 0

    def kill(self) -> None:
        self.returncode = -9

    async def wait(self) -> int:
        await asyncio.sleep(0)
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


class PendingProcess:
    def __init__(self, pid: int) -> None:
        self.pid = pid
        self.stdout = FakeStream([])
        self.stderr = FakeStream([])
        self.returncode: int | None = None

    def terminate(self) -> None:
        self.returncode = 0

    def kill(self) -> None:
        self.returncode = -9

    async def wait(self) -> int:
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


def make_instance(tmp_path: Path) -> InstanceRecord:
    instance_dir = tmp_path / "conductor-data" / "instances" / "inst-1"
    return InstanceRecord.create(
        id="inst-1",
        name="Alpha",
        repo_source_type="local_path",
        repo_source_value=str(tmp_path / "repo"),
        resolved_repo_path=str(tmp_path / "repo"),
        instance_dir=str(instance_dir),
        workspace_root=str(instance_dir / "workspace"),
        persistence_path=str(instance_dir / "state" / "performer.json"),
        log_path=str(instance_dir / "logs" / "performer.log"),
        http_port=8801,
        linear_project="ENG",
        linear_filters={"labels": ["codex"]},
    )


def pipeline_start_kwargs() -> dict[str, str]:
    return {
        "mode": "plan",
        "attempt_request_path": "/tmp/request.json",
        "attempt_result_path": "/tmp/result.json",
    }


def expected_pipeline_log() -> str:
    return (
        "event=performer_stream stream=stdout mode=plan "
        "attempt_request_path=/tmp/request.json attempt_result_path=/tmp/result.json message=daemon started\n"
        "event=performer_stream stream=stderr mode=plan "
        "attempt_request_path=/tmp/request.json attempt_result_path=/tmp/result.json message=warning line\n"
    )


def pipeline_start_kwargs_for(attempt_id: str, tmp_path: Path, *, mode: str = "execute") -> dict[str, str]:
    attempt_dir = tmp_path / "state" / "pipeline" / attempt_id
    return {
        "mode": mode,
        "attempt_id": attempt_id,
        "lease_id": f"lease-{attempt_id}",
        "attempt_request_path": str(attempt_dir / "attempt-request.json"),
        "attempt_result_path": str(attempt_dir / "attempt-result.json"),
    }


async def wait_for_log(path: Path, expected: str) -> str:
    for _ in range(20):
        content = path.read_text(encoding="utf-8")
        if content == expected:
            return content
        await asyncio.sleep(0.01)
    return path.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_start_launches_performer_process_and_captures_logs(tmp_path: Path) -> None:
    process = FakeProcess()
    captured: dict[str, Any] = {}

    async def process_factory(*args: str, **kwargs: Any) -> FakeProcess:
        captured["args"] = args
        captured["kwargs"] = kwargs
        return process

    manager = ConductorRuntimeManager(process_factory=process_factory, command="performer")
    instance = make_instance(tmp_path)

    started = await manager.start(
        instance,
        env={
            "LINEAR_API_KEY": "conductor-token",
            "PODIUM_PROXY_TOKEN": "proxy-token",
            "CODEX_HOME": str(tmp_path / "managed-codex-home"),
            "CODEX_MODEL": "gpt-5.3-codex",
        },
        **pipeline_start_kwargs(),
    )

    assert captured["args"] == (
        "performer",
        "--mode",
        "plan",
        "--attempt-request-path",
        "/tmp/request.json",
        "--attempt-result-path",
        "/tmp/result.json",
    )
    assert captured["kwargs"]["cwd"] == instance.resolved_repo_path
    assert "LINEAR_API_KEY" not in captured["kwargs"]["env"]
    assert captured["kwargs"]["env"]["PODIUM_PROXY_TOKEN"] == "proxy-token"
    assert captured["kwargs"]["env"]["CODEX_HOME"] == str(tmp_path / "managed-codex-home")
    assert captured["kwargs"]["env"]["CODEX_MODEL"] == "gpt-5.3-codex"
    assert started.process_status == "running"
    assert started.pid == 4242
    current_log = Path(instance.instance_dir) / "logs" / "performer-000001.log"
    assert started.log_path == str(current_log)
    assert Path(instance.log_path).read_text(encoding="utf-8") == ""
    assert await wait_for_log(current_log, expected_pipeline_log()) == expected_pipeline_log()

    stopped = await manager.stop(started)

    assert process.terminated is True
    assert stopped.process_status == "stopped"
    assert stopped.pid is None


@pytest.mark.asyncio
async def test_parallel_attempts_for_same_instance_start_distinct_performer_processes(tmp_path: Path) -> None:
    processes = [PendingProcess(5001), PendingProcess(5002)]
    started_processes: list[PendingProcess] = []
    captured_args: list[tuple[str, ...]] = []

    async def process_factory(*args: str, **kwargs: Any) -> PendingProcess:
        captured_args.append(args)
        process = processes.pop(0)
        started_processes.append(process)
        return process

    manager = ConductorRuntimeManager(process_factory=process_factory, command="performer")
    instance = make_instance(tmp_path)

    first = await manager.start(instance, env={}, **pipeline_start_kwargs_for("exec-1", tmp_path))
    second = await manager.start(first, env={}, **pipeline_start_kwargs_for("exec-2", tmp_path))

    assert len(captured_args) == 2
    assert first.pid == 5001
    assert second.pid == 5002
    assert set(manager._handles) == {("inst-1", "exec-1"), ("inst-1", "exec-2")}

    stopped = await manager.stop(second)

    assert stopped.process_status == "stopped"
    assert all(process.returncode == 0 for process in started_processes)
    assert manager._handles == {}


@pytest.mark.asyncio
async def test_performer_streams_are_written_to_attempt_log(tmp_path: Path) -> None:
    process = FakeProcess()

    async def process_factory(*args: str, **kwargs: Any) -> FakeProcess:
        return process

    manager = ConductorRuntimeManager(process_factory=process_factory, command="performer")
    instance = make_instance(tmp_path)
    start_kwargs = pipeline_start_kwargs_for("exec-1", tmp_path)

    started = await manager.start(instance, env={}, **start_kwargs)
    attempt_log = tmp_path / "state" / "pipeline" / "exec-1" / "attempt.log"

    for _ in range(20):
        if attempt_log.exists() and "event=performer_stream" in attempt_log.read_text(encoding="utf-8"):
            break
        await asyncio.sleep(0.01)
    log_text = attempt_log.read_text(encoding="utf-8")

    assert "event=performer_stream stream=stdout mode=execute attempt_id=exec-1 lease_id=lease-exec-1" in log_text
    assert "event=performer_stream stream=stderr mode=execute attempt_id=exec-1 lease_id=lease-exec-1" in log_text
    assert f"attempt_request_path={start_kwargs['attempt_request_path']}" in log_text
    assert f"attempt_result_path={start_kwargs['attempt_result_path']}" in log_text
    assert "message=daemon started" in log_text
    assert "message=warning line" in log_text

    await manager.stop(started)


@pytest.mark.asyncio
async def test_performer_stream_logs_redact_secret_values(tmp_path: Path) -> None:
    process = FakeProcess()
    process.stdout = FakeStream([b"Authorization: Bearer stdout-secret token=abc123\n"])
    process.stderr = FakeStream([b"password=hunter2 client_secret=secret cookie=session\n"])

    async def process_factory(*args: str, **kwargs: Any) -> FakeProcess:
        return process

    manager = ConductorRuntimeManager(process_factory=process_factory, command="performer")
    instance = make_instance(tmp_path)

    started = await manager.start(instance, env={}, **pipeline_start_kwargs())
    current_log = Path(started.log_path)
    for _ in range(20):
        log_text = current_log.read_text(encoding="utf-8")
        if "event=performer_stream" in log_text and "cookie=" in log_text:
            break
        await asyncio.sleep(0.01)
    log_text = current_log.read_text(encoding="utf-8")

    assert "stdout-secret" not in log_text
    assert "abc123" not in log_text
    assert "hunter2" not in log_text
    assert "client_secret=secret" not in log_text
    assert "cookie=session" not in log_text
    assert "Authorization: [REDACTED]" in log_text
    assert "token=[REDACTED]" in log_text
    assert "password=[REDACTED]" in log_text
    assert "client_secret=[REDACTED]" in log_text
    assert "cookie=[REDACTED]" in log_text


@pytest.mark.asyncio
async def test_start_does_not_inherit_sensitive_runtime_credentials(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = FakeProcess()
    captured: dict[str, Any] = {}

    async def process_factory(*args: str, **kwargs: Any) -> FakeProcess:
        captured["args"] = args
        captured["kwargs"] = kwargs
        return process

    monkeypatch.setenv("LINEAR_API_KEY", "parent-linear-token")
    monkeypatch.setenv("PODIUM_PROXY_TOKEN", "parent-proxy-token")
    monkeypatch.setenv("PODIUM_RUNTIME_TOKEN", "parent-runtime-token")
    manager = ConductorRuntimeManager(process_factory=process_factory, command="performer")
    instance = make_instance(tmp_path)

    await manager.start(instance, env={}, **pipeline_start_kwargs())

    env = captured["kwargs"]["env"]
    assert "LINEAR_API_KEY" not in env
    assert "PODIUM_PROXY_TOKEN" not in env
    assert "PODIUM_RUNTIME_TOKEN" not in env


@pytest.mark.asyncio
async def test_start_does_not_inherit_parent_codex_runtime_controls(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = FakeProcess()
    captured: dict[str, Any] = {}

    async def process_factory(*args: str, **kwargs: Any) -> FakeProcess:
        captured["kwargs"] = kwargs
        return process

    monkeypatch.setenv("CODEX_SANDBOX", "seatbelt")
    monkeypatch.setenv("CODEX_THREAD_ID", "thread-parent")
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "parent-codex"))
    manager = ConductorRuntimeManager(process_factory=process_factory, command="performer")
    instance = make_instance(tmp_path)

    await manager.start(
        instance,
        env={
            "CODEX_HOME": str(tmp_path / "managed-codex-home"),
            "CODEX_MODEL": "gpt-5.3-codex",
        },
        **pipeline_start_kwargs(),
    )

    env = captured["kwargs"]["env"]
    assert env["CODEX_HOME"] == str(tmp_path / "managed-codex-home")
    assert env["CODEX_MODEL"] == "gpt-5.3-codex"
    assert "CODEX_SANDBOX" not in env
    assert "CODEX_THREAD_ID" not in env


@pytest.mark.asyncio
async def test_concurrent_start_reserves_handle_before_process_factory_returns(tmp_path: Path) -> None:
    calls = 0
    entered = asyncio.Event()
    release = asyncio.Event()

    async def process_factory(*args: str, **kwargs: Any) -> PendingProcess:
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        return PendingProcess(5000 + calls)

    manager = ConductorRuntimeManager(process_factory=process_factory, command="performer")
    instance = make_instance(tmp_path)

    first_task = asyncio.create_task(manager.start(instance, env={}, **pipeline_start_kwargs()))
    await entered.wait()
    second_task = asyncio.create_task(manager.start(instance, env={}, **pipeline_start_kwargs()))
    await asyncio.sleep(0)
    release.set()
    first = await first_task
    second = await second_task

    assert calls == 1
    assert second.process_status in {"starting", "running"}
    assert first.pid == 5001
    assert len(manager._handles) == 1


@pytest.mark.asyncio
async def test_restart_creates_new_generation_without_truncating_previous_log(tmp_path: Path) -> None:
    processes = [FakeProcess(), FakeProcess()]

    async def process_factory(*args: str, **kwargs: Any) -> FakeProcess:
        return processes.pop(0)

    manager = ConductorRuntimeManager(process_factory=process_factory, command="performer")
    instance = make_instance(tmp_path)

    first = await manager.start(instance, env={}, **pipeline_start_kwargs())
    first_log = Path(first.log_path)
    assert await wait_for_log(first_log, expected_pipeline_log()) == expected_pipeline_log()
    await manager.stop(first)

    second = await manager.start(first, env={}, **pipeline_start_kwargs())

    assert first_log.read_text(encoding="utf-8") == expected_pipeline_log()
    assert Path(second.log_path).name == "performer-000002.log"
    assert Path(second.instance_dir, "logs", "current.log").read_text(encoding="utf-8") == str(Path(second.log_path))


def test_query_logs_supports_tail_order_limit_and_previous_generation(tmp_path: Path) -> None:
    manager = ConductorRuntimeManager(command="performer")
    instance = make_instance(tmp_path)
    logs_dir = Path(instance.instance_dir) / "logs"
    logs_dir.mkdir(parents=True)
    previous = logs_dir / "performer-000001.log"
    current = logs_dir / "performer-000002.log"
    previous.write_text("old-1\nold-2\n", encoding="utf-8")
    current.write_text("new-1\nnew-2\nnew-3\n", encoding="utf-8")

    desc = manager.query_logs(instance.with_updates(log_path=str(current)), LogQuery(tail=2, order="desc"))
    asc = manager.query_logs(instance.with_updates(log_path=str(current)), LogQuery(tail=2, order="asc"))
    limited = manager.query_logs(instance.with_updates(log_path=str(current)), LogQuery(limit_bytes=6, order="asc"))
    previous_result = manager.query_logs(instance.with_updates(log_path=str(current)), LogQuery(previous=True, order="asc"))

    assert desc.lines == ["new-3", "new-2"]
    assert asc.lines == ["new-2", "new-3"]
    assert "".join(line + "\n" for line in limited.lines).encode()[-6:] == b"new-3\n"
    assert previous_result.generation == 1
    assert previous_result.lines == ["old-1", "old-2"]


def test_default_command_falls_back_to_python_module_in_editable_repo() -> None:
    manager = ConductorRuntimeManager(process_factory=None)

    if manager.command.endswith("/performer"):
        assert manager._command_args(
            mode="plan",
            attempt_request_path="/tmp/request.json",
            attempt_result_path="/tmp/result.json",
        ) == (
            manager.command,
            "--mode",
            "plan",
            "--attempt-request-path",
            "/tmp/request.json",
            "--attempt-result-path",
            "/tmp/result.json",
        )
    else:
        assert manager._command_args(
            mode="plan",
            attempt_request_path="/tmp/request.json",
            attempt_result_path="/tmp/result.json",
        ) == (
            manager.command,
            "-m",
            "performer.cli",
            "--mode",
            "plan",
            "--attempt-request-path",
            "/tmp/request.json",
            "--attempt-result-path",
            "/tmp/result.json",
        )


def test_command_args_do_not_include_legacy_dispatch_issue() -> None:
    manager = ConductorRuntimeManager(command="performer")

    assert manager._command_args(
        mode="execute",
        attempt_request_path="/tmp/request.json",
        attempt_result_path="/tmp/result.json",
    ) == (
        "performer",
        "--mode",
        "execute",
        "--attempt-request-path",
        "/tmp/request.json",
        "--attempt-result-path",
        "/tmp/result.json",
    )


def test_command_args_signature_has_no_legacy_phase_paths() -> None:
    manager = ConductorRuntimeManager(command="performer")
    parameters = inspect.signature(manager._command_args).parameters

    assert "advance_request_path" not in parameters
    assert "phase_result_path" not in parameters


def test_command_args_include_runtime_mode_attempt_paths() -> None:
    manager = ConductorRuntimeManager(command="performer")

    assert manager._command_args(
        mode="verify",
        attempt_request_path="/tmp/attempt-request.json",
        attempt_result_path="/tmp/attempt-result.json",
    ) == (
        "performer",
        "--mode",
        "verify",
        "--attempt-request-path",
        "/tmp/attempt-request.json",
        "--attempt-result-path",
        "/tmp/attempt-result.json",
    )


def test_process_env_allows_local_verifier_runtime_home(tmp_path: Path) -> None:
    manager = ConductorRuntimeManager(command="performer")
    verifier_home = tmp_path / "runtime-homes" / "verify" / "local-verifier"

    env = manager._process_env({"SYMPHONY_LOCAL_VERIFIER_HOME": str(verifier_home)})

    assert env["SYMPHONY_LOCAL_VERIFIER_HOME"] == str(verifier_home)


def test_process_env_allows_local_verifier_replan_failure_probe() -> None:
    manager = ConductorRuntimeManager(command="performer")

    env = manager._process_env(
        {
            "SYMPHONY_FORCE_FIRST_VERIFY_FAILURE_FOR_REPLAN": "1",
            "SYMPHONY_LOCAL_VERIFIER_PROBE_HOME": "/tmp/probe-home",
        }
    )

    assert env["SYMPHONY_FORCE_FIRST_VERIFY_FAILURE_FOR_REPLAN"] == "1"
    assert env["SYMPHONY_LOCAL_VERIFIER_PROBE_HOME"] == "/tmp/probe-home"


def test_process_env_allows_codex_runtime_wait_probe() -> None:
    manager = ConductorRuntimeManager(command="performer")

    env = manager._process_env(
        {
            "CODEX_EMIT_RUNTIME_WAIT_PROBE": "True",
            "CODEX_RUNTIME_WAIT_PROBE_SECONDS": "25",
        }
    )

    assert env["CODEX_EMIT_RUNTIME_WAIT_PROBE"] == "True"
    assert env["CODEX_RUNTIME_WAIT_PROBE_SECONDS"] == "25"


def test_refresh_polls_process_before_reporting_running(tmp_path: Path) -> None:
    class PollingProcess:
        pid = 4242
        returncode = None

        def poll(self):
            self.returncode = 0
            return 0

    manager = ConductorRuntimeManager(command="performer")
    instance = make_instance(tmp_path).with_updates(process_status="running", pid=4242)
    manager._handles[(instance.id, "exec-1")] = RuntimeHandle(
        process=PollingProcess(),
        log_task=None,  # type: ignore[arg-type]
        process_status="running",
        attempt_id="exec-1",
    )

    refreshed = manager.refresh(instance)

    assert refreshed.process_status == "exited"
    assert refreshed.pid is None
    assert refreshed.last_exit_code == 0


def test_refresh_keeps_exited_attempt_metadata_while_other_attempt_runs(tmp_path: Path) -> None:
    manager = ConductorRuntimeManager(command="performer")
    instance = make_instance(tmp_path).with_updates(process_status="running", pid=5002)
    first_kwargs = pipeline_start_kwargs_for("exec-1", tmp_path, mode="execute")
    second_kwargs = pipeline_start_kwargs_for("verify-1", tmp_path, mode="verify")
    exited = PendingProcess(5001)
    exited.returncode = 7
    running = PendingProcess(5002)
    manager._handles[(instance.id, "exec-1")] = RuntimeHandle(
        process=exited,
        log_task=None,  # type: ignore[arg-type]
        process_status="running",
        attempt_id="exec-1",
        mode=first_kwargs["mode"],
        lease_id=first_kwargs["lease_id"],
        request_path=first_kwargs["attempt_request_path"],
        result_path=first_kwargs["attempt_result_path"],
    )
    manager._handles[(instance.id, "verify-1")] = RuntimeHandle(
        process=running,
        log_task=None,  # type: ignore[arg-type]
        process_status="running",
        attempt_id="verify-1",
        mode=second_kwargs["mode"],
        lease_id=second_kwargs["lease_id"],
        request_path=second_kwargs["attempt_request_path"],
        result_path=second_kwargs["attempt_result_path"],
    )

    refreshed = manager.refresh(instance)
    drained = manager.drain_exited_attempts(instance)

    assert refreshed.process_status == "running"
    assert refreshed.pid == 5002
    assert drained == [
        {
            "instance_id": "inst-1",
            "attempt_id": "exec-1",
            "mode": "execute",
            "lease_id": "lease-exec-1",
            "request_path": first_kwargs["attempt_request_path"],
            "result_path": first_kwargs["attempt_result_path"],
            "pid": 5001,
            "exit_code": 7,
        }
    ]
    assert set(manager._handles) == {("inst-1", "verify-1")}


def test_drain_exited_attempts_returns_each_exit_once(tmp_path: Path) -> None:
    manager = ConductorRuntimeManager(command="performer")
    instance = make_instance(tmp_path).with_updates(process_status="running", pid=5001)
    start_kwargs = pipeline_start_kwargs_for("exec-1", tmp_path)
    exited = PendingProcess(5001)
    exited.returncode = 3
    manager._handles[(instance.id, "exec-1")] = RuntimeHandle(
        process=exited,
        log_task=None,  # type: ignore[arg-type]
        process_status="running",
        attempt_id="exec-1",
        mode=start_kwargs["mode"],
        lease_id=start_kwargs["lease_id"],
        request_path=start_kwargs["attempt_request_path"],
        result_path=start_kwargs["attempt_result_path"],
    )

    manager.refresh(instance)
    first_drain = manager.drain_exited_attempts(instance)
    second_drain = manager.drain_exited_attempts(instance)

    assert [snapshot["attempt_id"] for snapshot in first_drain] == ["exec-1"]
    assert second_drain == []


def test_refresh_marks_missing_pid_exited_without_runtime_handle(tmp_path: Path) -> None:
    manager = ConductorRuntimeManager(command="performer")
    instance = make_instance(tmp_path).with_updates(process_status="running", pid=999999)

    refreshed = manager.refresh(instance)

    assert refreshed.process_status == "exited"
    assert refreshed.pid is None
    assert refreshed.last_exit_code != 0


def test_refresh_rejects_reused_pid_with_non_performer_cmdline(tmp_path: Path) -> None:
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        manager = ConductorRuntimeManager(command="performer")
        instance = make_instance(tmp_path).with_updates(process_status="running", pid=process.pid)

        refreshed = manager.refresh(instance)

        assert refreshed.process_status == "exited"
        assert refreshed.pid is None
        assert refreshed.last_exit_code != 0
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)


@pytest.mark.asyncio
async def test_recovered_process_log_query_reports_pipe_warning(tmp_path: Path) -> None:
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "performer"])
    try:
        manager = ConductorRuntimeManager(command="performer")
        instance = make_instance(tmp_path).with_updates(process_status="running", pid=process.pid)
        log_path = Path(instance.instance_dir) / "logs" / "performer-000001.log"
        log_path.parent.mkdir(parents=True)
        log_path.write_text("before restart\n", encoding="utf-8")
        instance = instance.with_updates(log_path=str(log_path))

        recovered = manager.recover(instance)
        assert recovered is not None
        logs = manager.query_logs(recovered, LogQuery(order="asc"))

        assert logs.lines == ["before restart"]
        assert logs.warnings == [
            "stdout/stderr pipes could not be reattached after Conductor restart; showing persisted log file only"
        ]
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)


@pytest.mark.asyncio
async def test_recover_does_not_resurrect_dead_pid_from_log_file(tmp_path: Path) -> None:
    manager = ConductorRuntimeManager(command="performer")
    instance = make_instance(tmp_path).with_updates(process_status="running", pid=999999)
    log_path = Path(instance.instance_dir) / "logs" / "performer-000001.log"
    log_path.parent.mkdir(parents=True)
    log_path.write_text("persisted log\n", encoding="utf-8")
    instance = instance.with_updates(log_path=str(log_path))

    recovered = manager.recover(instance)

    assert recovered is None


@pytest.mark.asyncio
async def test_stop_recovers_running_pid_when_handle_cache_is_empty(tmp_path: Path) -> None:
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "performer"])
    try:
        manager = ConductorRuntimeManager(command="performer")
        instance = make_instance(tmp_path).with_updates(process_status="running", pid=process.pid)

        recovered = manager.recover(instance)
        assert recovered is not None
        stopped = await manager.stop(recovered)

        assert stopped.process_status == "stopped"
        assert stopped.pid is None
        assert process.poll() is not None
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
