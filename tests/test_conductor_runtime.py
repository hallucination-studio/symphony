from __future__ import annotations

import asyncio
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
        workflow_path=str(instance_dir / "WORKFLOW.md"),
        workspace_root=str(instance_dir / "workspace"),
        persistence_path=str(instance_dir / "state" / "performer.json"),
        log_path=str(instance_dir / "logs" / "performer.log"),
        http_port=8801,
        linear_project="ENG",
        linear_filters={"labels": ["codex"]},
        workflow_profile="default",
        workflow_inputs={},
    )


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

    started = await manager.start(instance, env={"LINEAR_API_KEY": "conductor-token"})

    assert captured["args"] == ("performer", instance.workflow_path)
    assert captured["kwargs"]["cwd"] == instance.resolved_repo_path
    assert captured["kwargs"]["env"]["LINEAR_API_KEY"] == "conductor-token"
    assert started.process_status == "running"
    assert started.pid == 4242
    current_log = Path(instance.instance_dir) / "logs" / "performer-000001.log"
    assert started.log_path == str(current_log)
    assert Path(instance.log_path).read_text(encoding="utf-8") == ""
    assert await wait_for_log(current_log, "daemon started\nwarning line\n") == "daemon started\nwarning line\n"

    stopped = await manager.stop(started)

    assert process.terminated is True
    assert stopped.process_status == "stopped"
    assert stopped.pid is None


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

    await manager.start(instance, env={})

    env = captured["kwargs"]["env"]
    assert "LINEAR_API_KEY" not in env
    assert "PODIUM_PROXY_TOKEN" not in env
    assert "PODIUM_RUNTIME_TOKEN" not in env


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

    first_task = asyncio.create_task(manager.start(instance, env={}))
    await entered.wait()
    second_task = asyncio.create_task(manager.start(instance, env={}))
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

    first = await manager.start(instance, env={})
    first_log = Path(first.log_path)
    assert await wait_for_log(first_log, "daemon started\nwarning line\n") == "daemon started\nwarning line\n"
    await manager.stop(first)

    second = await manager.start(first, env={})

    assert first_log.read_text(encoding="utf-8") == "daemon started\nwarning line\n"
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
        assert manager._command_args("WORKFLOW.md") == (manager.command, "WORKFLOW.md")
    else:
        assert manager._command_args("WORKFLOW.md") == (manager.command, "-m", "performer.cli", "WORKFLOW.md")


def test_command_args_do_not_include_legacy_dispatch_issue() -> None:
    manager = ConductorRuntimeManager(command="performer")

    assert manager._command_args("WORKFLOW.md") == (
        "performer",
        "WORKFLOW.md",
    )


def test_command_args_include_phase_request_and_result_paths() -> None:
    manager = ConductorRuntimeManager(command="performer")

    assert manager._command_args(
        "WORKFLOW.md",
        advance_request_path="/tmp/request.json",
        phase_result_path="/tmp/result.json",
    ) == (
        "performer",
        "WORKFLOW.md",
        "--advance-request-path",
        "/tmp/request.json",
        "--phase-result-path",
        "/tmp/result.json",
    )


def test_refresh_polls_process_before_reporting_running(tmp_path: Path) -> None:
    class PollingProcess:
        pid = 4242
        returncode = None

        def poll(self):
            self.returncode = 0
            return 0

    manager = ConductorRuntimeManager(command="performer")
    instance = make_instance(tmp_path).with_updates(process_status="running", pid=4242)
    manager._handles[instance.id] = RuntimeHandle(
        process=PollingProcess(),
        log_task=None,  # type: ignore[arg-type]
        process_status="running",
    )

    refreshed = manager.refresh(instance)

    assert refreshed.process_status == "exited"
    assert refreshed.pid is None
    assert refreshed.last_exit_code == 0


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
