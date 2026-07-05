from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol


class AgentBackend(Protocol):
    async def run_session(self, workspace_path: Path, prompt: str, title: str, **kwargs: Any) -> Any:
        """Run one agent turn/session and return backend-owned structured output."""
        ...
