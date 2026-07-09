from __future__ import annotations

import itertools
from typing import Any

from .codex_client_helper_async import _maybe_await


_ADAPTER_TURN_IDS = itertools.count(1)


class _ThreadRunAdapter:
    def __init__(self, thread: Any, output_schema: dict[str, Any], prompt: str):
        self.id = f"turn-{next(_ADAPTER_TURN_IDS)}"
        self.thread = thread
        self.output_schema = output_schema
        self.prompt = prompt

    async def run(self) -> Any:
        run = getattr(self.thread, "run")
        try:
            result = await _maybe_await(run(self.prompt, output_schema=self.output_schema))
        except TypeError:
            result = await _maybe_await(run(self.prompt))
        nested_run = getattr(result, "run", None)
        if callable(nested_run):
            return await _maybe_await(nested_run())
        return result
