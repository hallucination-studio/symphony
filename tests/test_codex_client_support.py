from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import performer.codex_client as codex_client
from performer.codex_client import CodexError, CodexSdkClient
from performer_api.config import CodexConfig

openai_errors = pytest.importorskip("openai_codex.errors")


class FakeSdkTurn:
    id = "turn-1"

    async def run(self) -> dict[str, Any]:
        return {
            "final_response": json.dumps(
                {
                    "summary": "implemented",
                    "test_commands": ["pytest -q"],
                    "changed_files": ["a.py"],
                    "remaining_risks": [],
                    "next_action": "ready_for_review",
                }
            ),
            "usage": {
                "input_tokens": 12,
                "output_tokens": 4,
                "cached_tokens": 2,
                "total_tokens": 18,
            },
        }


class FakeSdkThread:
    def __init__(self, thread_id: str):
        self.id = thread_id
        self.prompts: list[Any] = []

    def turn(self, *args: Any, **kwargs: Any) -> FakeSdkTurn:
        self.prompts.append((args, kwargs))
        return FakeSdkTurn()


class FakeSdk:
    def __init__(self):
        self.started: list[dict[str, Any]] = []
        self.resumed: list[tuple[str, dict[str, Any]]] = []

    async def thread_start(self, **kwargs: Any) -> FakeSdkThread:
        self.started.append(kwargs)
        return FakeSdkThread("thread-new")

    async def thread_resume(self, thread_id: str, **kwargs: Any) -> FakeSdkThread:
        self.resumed.append((thread_id, kwargs))
        return FakeSdkThread(thread_id)


def server_busy(message: str = "upstream 502: server overloaded") -> Exception:
    return openai_errors.ServerBusyError(
        -32000,
        message,
        {"codex_error_info": "server_overloaded", "httpStatusCode": 502},
    )


def invalid_params(message: str = "invalid request shape") -> Exception:
    return openai_errors.InvalidParamsError(-32602, message, {"httpStatusCode": 400})
