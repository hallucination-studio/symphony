from __future__ import annotations

import asyncio
import logging
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

from .config import HooksConfig, WorkspaceConfig


logger = logging.getLogger(__name__)


class WorkspaceError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Workspace:
    path: Path
    workspace_key: str
    created_now: bool


def sanitize_workspace_key(identifier: str) -> str:
    sanitized = re.sub(r"[^A-Za-z0-9._-]", "_", identifier.strip())
    return sanitized or "issue"


class WorkspaceManager:
    def __init__(self, workspace: WorkspaceConfig, hooks: HooksConfig):
        self.config = workspace
        self.hooks = hooks

    async def create_for_issue(self, identifier: str) -> Workspace:
        key = sanitize_workspace_key(identifier)
        path = self._path_for_key(key) if self.config.per_issue else self.config.root.resolve()
        created_now = False
        if path.exists() and not path.is_dir():
            raise WorkspaceError("workspace_path_not_directory", f"Workspace path is not a directory: {path}")
        if not path.exists():
            path.mkdir(parents=True, exist_ok=False)
            created_now = True
        workspace = Workspace(path=path, workspace_key=key, created_now=created_now)
        if created_now and self.hooks.after_create:
            await self._run_hook("after_create", self.hooks.after_create, path, fatal=True)
        return workspace

    async def run_before_run(self, path: Path) -> None:
        self.validate_workspace_path(path)
        if self.hooks.before_run:
            await self._run_hook("before_run", self.hooks.before_run, path, fatal=True)

    async def run_after_run(self, path: Path) -> None:
        self.validate_workspace_path(path)
        if self.hooks.after_run:
            await self._run_hook("after_run", self.hooks.after_run, path, fatal=False)

    async def remove_for_issue(self, identifier: str) -> None:
        if not self.config.per_issue:
            return
        path = self._path_for_key(sanitize_workspace_key(identifier))
        if not path.exists():
            return
        if self.hooks.before_remove:
            await self._run_hook("before_remove", self.hooks.before_remove, path, fatal=False)
        shutil.rmtree(path)

    def path_for_issue(self, identifier: str) -> Path:
        if not self.config.per_issue:
            return self.config.root.resolve()
        return self._path_for_key(sanitize_workspace_key(identifier))

    def validate_workspace_path(self, path: Path) -> None:
        root = self.config.root.resolve()
        candidate = path.resolve()
        if candidate != root and root not in candidate.parents:
            raise WorkspaceError("workspace_path_outside_root", f"Workspace path escapes root: {candidate}")

    def _path_for_key(self, key: str) -> Path:
        root = self.config.root.resolve()
        path = (root / key).resolve()
        if path != root and root not in path.parents:
            raise WorkspaceError("workspace_path_outside_root", f"Workspace path escapes root: {path}")
        return path

    async def _run_hook(self, name: str, script: str, cwd: Path, *, fatal: bool) -> None:
        logger.info("symphony_hook outcome=started hook=%s cwd=%s", name, cwd)
        try:
            process = await asyncio.create_subprocess_exec(
                "bash",
                "-lc",
                script,
                cwd=str(cwd),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(
                process.communicate(), timeout=self.hooks.timeout_ms / 1000
            )
        except TimeoutError as exc:
            logger.warning("symphony_hook outcome=timeout hook=%s timeout_ms=%s", name, self.hooks.timeout_ms)
            if fatal:
                raise WorkspaceError("hook_timeout", f"{name} timed out") from exc
            return
        except OSError as exc:
            logger.warning("symphony_hook outcome=failed hook=%s reason=%s", name, exc)
            if fatal:
                raise WorkspaceError("hook_failed", f"{name} could not start: {exc}") from exc
            return

        if process.returncode != 0:
            message = (stderr or stdout).decode(errors="replace")[:500]
            logger.warning(
                "symphony_hook outcome=failed hook=%s exit_code=%s message=%s",
                name,
                process.returncode,
                message,
            )
            if fatal:
                raise WorkspaceError("hook_failed", f"{name} failed with {process.returncode}: {message}")
            return
        logger.info("symphony_hook outcome=completed hook=%s", name)
