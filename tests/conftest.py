from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from performer_api.workflow import Task


def _task_payload() -> dict[str, object]:
    return Task(
        id="task-1",
        title="Implement the endpoint",
        objective="Add the requested endpoint",
        acceptance_criteria=["The endpoint returns 200"],
        verification_commands=["pytest -q tests/test_endpoint.py"],
        files_likely_touched=["src/api.py"],
    ).to_dict()


@pytest.fixture
def task_payload() -> dict[str, object]:
    return _task_payload()


@pytest.fixture
def minimal_task() -> Task:
    return Task.from_dict(_task_payload())


class FakeCodexClient:
    def __init__(self, structured_result: dict[str, object], events: list[dict[str, object]] | None = None) -> None:
        self.structured_result = structured_result
        self.events = events or []
        self.calls: list[dict[str, object]] = []

    async def run_session(self, workspace: Path, prompt: str, title: str, **kwargs: object) -> SimpleNamespace:
        self.calls.append({"workspace": workspace, "prompt": prompt, "title": title, **kwargs})
        return SimpleNamespace(thread_id="thread-1", structured_result=self.structured_result, events=self.events)


@pytest.fixture
def fake_codex_client():
    return FakeCodexClient
