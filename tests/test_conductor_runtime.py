from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from conductor.conductor_models import InstanceRecord
from conductor.conductor_runtime import ConductorRuntimeManager, LogQuery


class FakeStream:
    def __init__(self, chunks: list[bytes]):
        self.chunks = chunks

    async def readline(self) -> bytes:
        await asyncio.sleep(0)
        if not self.chunks:
            return b""
        return self.chunks.pop(0)


class FakeProcess:
    def __init__(self) -> None:
        self.pid = 4242
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


def test_command_args_can_target_event_dispatch_issue() -> None:
    manager = ConductorRuntimeManager(command="performer")

    assert manager._command_args("WORKFLOW.md", dispatch_issue_id="issue-1") == (
        "performer",
        "WORKFLOW.md",
        "--dispatch-issue-id",
        "issue-1",
    )
