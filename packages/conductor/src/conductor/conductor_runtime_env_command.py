from __future__ import annotations

import os
from pathlib import Path
import sys

from .conductor_runtime_types import ALLOWED_RUNTIME_OVERRIDE_KEYS, SENSITIVE_RUNTIME_ENV_KEYS


class RuntimeEnvCommandMixin:
    def _default_performer_command(self) -> str:
        sibling = Path(sys.executable).with_name("performer")
        if sibling.exists():
            return str(sibling)
        repo_performer = Path(__file__).resolve().parents[3] / "performer" / "src"
        if repo_performer.exists():
            return sys.executable
        return "performer"

    def _process_env(self, overrides: dict[str, str] | None) -> dict[str, str]:
        env = dict(os.environ)
        for key in SENSITIVE_RUNTIME_ENV_KEYS:
            env.pop(key, None)
        for key in list(env):
            if key.startswith("CODEX_"):
                env.pop(key, None)
        if overrides:
            env.update({key: value for key, value in overrides.items() if key in ALLOWED_RUNTIME_OVERRIDE_KEYS})
        package_root = Path(__file__).resolve().parents[3]
        local_srcs = [
            str(package_root / "performer-api" / "src"),
            str(package_root / "performer" / "src"),
            str(package_root / "conductor" / "src"),
            str(package_root / "podium" / "src"),
        ]
        existing = env.get("PYTHONPATH")
        paths = existing.split(os.pathsep) if existing else []
        for local_src in reversed(local_srcs):
            if local_src not in paths:
                paths.insert(0, local_src)
        env["PYTHONPATH"] = os.pathsep.join(paths)
        return env

    def _command_args(
        self,
        *,
        mode: str | None = None,
        attempt_request_path: str | None = None,
        attempt_result_path: str | None = None,
    ) -> tuple[str, ...]:
        _ = mode
        if not attempt_request_path or not attempt_result_path:
            raise ValueError("--turn-request-path and --turn-result-path are required for Performer launches")
        if self.command == sys.executable:
            args = (self.command, "-m", "performer.cli")
        else:
            args = (self.command,)
        return (
            *args,
            "--turn-request-path",
            attempt_request_path,
            "--turn-result-path",
            attempt_result_path,
        )
