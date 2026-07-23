from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from performer.backends.codex.codex_backend_impl import CodexBackendImpl
from performer.backends.provider_backend_interface import ProviderBackendError


class FakeThread:
    id = "thread-1"

    def __init__(self, response: str = '{"kind":"wait"}') -> None:
        self.response = response
        self.calls: list[tuple[str, dict[str, object]]] = []

    def turn(self, prompt: str, **kwargs: object):
        self.calls.append((prompt, kwargs))
        result = SimpleNamespace(
            status="completed",
            error=None,
            final_response=self.response,
            usage=SimpleNamespace(total=SimpleNamespace(total_tokens=3)),
        )
        return SimpleNamespace(run=lambda: result, interrupt=lambda: None)


class FakeCodex:
    def __init__(self, thread: FakeThread | None = None) -> None:
        self.thread = thread or FakeThread()
        self.started: list[dict[str, object]] = []
        self.archived: list[str] = []

    def thread_start(self, **kwargs: object):
        self.started.append(kwargs)
        return self.thread

    def thread_archive(self, thread_id: str) -> None:
        self.archived.append(thread_id)

    def account(self, refresh_token: bool = False):
        return SimpleNamespace(account=SimpleNamespace(root=SimpleNamespace(type="chatgpt")))


def test_role_session_uses_role_specific_instructions_and_returns_json():
    sdk = FakeCodex(FakeThread('{"action":{"kind":"wait"}}'))
    backend = CodexBackendImpl(sdk)
    session = backend.open_role_session("root_reconciler", {"model": "gpt"})

    result = backend.execute_role_turn(
        session,
        {"root_issue_id": "root-1", "observed_root_tree_digest": "tree-1"},
        workspace_root=None,
        cancel_event=__import__("threading").Event(),
    )

    assert result["output"]["action"]["kind"] == "wait"
    assert "Root Reconciler" in sdk.started[0]["base_instructions"]
    assert "Do not use tools or inspect the workspace" in sdk.started[0]["base_instructions"]
    assert "root-1" in sdk.thread.calls[0][0]
    assert sdk.thread.calls[0][1]["output_schema"]["required"] == ["action"]
    assert "RETURN ONLY THE JSON OBJECT." in sdk.thread.calls[0][0]
    assert "additionalProperties" not in sdk.thread.calls[0][0]


def test_work_role_receives_workspace_and_is_archived():
    sdk = FakeCodex()
    backend = CodexBackendImpl(sdk)
    session = backend.open_role_session("work", {"model": "gpt"})
    backend.execute_role_turn(
        session,
        {"role": "work", "target_issue_id": "work-1"},
        workspace_root=None,
        cancel_event=__import__("threading").Event(),
    )
    backend.close_role_session(session)

    assert sdk.started[0]["sandbox"].value == "workspace-write"
    assert sdk.archived == ["thread-1"]


def test_invalid_provider_json_is_sanitized():
    sdk = FakeCodex(FakeThread("not-json"))
    backend = CodexBackendImpl(sdk)
    session = backend.open_role_session("plan", {"model": "gpt"})

    with pytest.raises(ProviderBackendError) as raised:
        backend.execute_role_turn(
            session,
            {},
            workspace_root=None,
            cancel_event=__import__("threading").Event(),
        )

    assert raised.value.code == "provider_output_invalid"
    assert "not-json" not in raised.value.sanitized_reason
