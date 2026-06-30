from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from symphony.conductor_models import InstanceRecord
from symphony.conductor_runtime import ConductorRuntimeManager


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
        persistence_path=str(instance_dir / "state" / "symphony.json"),
        log_path=str(instance_dir / "logs" / "symphony.log"),
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
async def test_start_launches_symphony_process_and_captures_logs(tmp_path: Path) -> None:
    process = FakeProcess()
    captured: dict[str, Any] = {}

    async def process_factory(*args: str, **kwargs: Any) -> FakeProcess:
        captured["args"] = args
        captured["kwargs"] = kwargs
        return process

    manager = ConductorRuntimeManager(process_factory=process_factory, command="symphony")
    instance = make_instance(tmp_path)

    started = await manager.start(instance, env={"LINEAR_API_KEY": "conductor-token"})

    assert captured["args"] == ("symphony", instance.workflow_path)
    assert captured["kwargs"]["cwd"] == instance.resolved_repo_path
    assert captured["kwargs"]["env"]["LINEAR_API_KEY"] == "conductor-token"
    assert started.process_status == "running"
    assert started.pid == 4242
    assert await wait_for_log(Path(instance.log_path), "daemon started\nwarning line\n") == "daemon started\nwarning line\n"

    stopped = await manager.stop(started)

    assert process.terminated is True
    assert stopped.process_status == "stopped"
    assert stopped.pid is None
