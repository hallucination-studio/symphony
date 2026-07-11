from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from performer_api.turns import TurnContext


class RuntimeExecutionError(RuntimeError):
    pass


class StaleRuntimeResult(RuntimeError):
    pass


@dataclass(frozen=True)
class RuntimePaths:
    root: Path
    request: Path
    result: Path
    log: Path


class PerformerRuntime:
    ALLOWED_CODEX_SEED_FILES = frozenset({"config.toml", "auth.json", "version.json", "models_cache.json"})

    def __init__(self, performer_command: Sequence[str] = ("performer",)) -> None:
        self.performer_command = tuple(performer_command)

    def stage_codex_home(self, seed_home: Path, run_root: Path) -> Path:
        if not seed_home.is_dir():
            raise RuntimeExecutionError("managed_codex_home_seed_required")
        codex_home = run_root / "CODEX_HOME"
        codex_home.mkdir(parents=True, exist_ok=True)
        for name in self.ALLOWED_CODEX_SEED_FILES:
            source = seed_home / name
            if source.is_file():
                shutil.copy2(source, codex_home / name)
        return codex_home

    def paths(self, run_root: Path) -> RuntimePaths:
        run_root.mkdir(parents=True, exist_ok=True)
        return RuntimePaths(run_root, run_root / "turn-request.json", run_root / "turn-result.json", run_root / "performer.log")

    def write_request(self, paths: RuntimePaths, payload: dict[str, Any]) -> None:
        paths.request.write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")), encoding="utf-8")

    def run(self, paths: RuntimePaths, *, codex_home: Path, env: dict[str, str] | None = None) -> dict[str, Any]:
        process_env = {**os.environ, **(env or {}), "CODEX_HOME": str(codex_home)}
        command = [*self.performer_command, "--turn-request-path", str(paths.request), "--turn-result-path", str(paths.result)]
        try:
            completed = subprocess.run(command, env=process_env, capture_output=True, text=True, check=False)
        except OSError as exc:
            raise RuntimeExecutionError(f"performer_start_failed:{exc}") from exc
        paths.log.write_text(
            f"stdout\n{completed.stdout}\nstderr\n{completed.stderr}\nexit_code={completed.returncode}\n",
            encoding="utf-8",
        )
        if completed.returncode != 0:
            raise RuntimeExecutionError(f"performer_failed:exit_{completed.returncode}")
        try:
            payload = json.loads(paths.result.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeExecutionError("performer_result_invalid") from exc
        if not isinstance(payload, dict):
            raise RuntimeExecutionError("performer_result_invalid")
        return payload

    @staticmethod
    def accept_result(expected: TurnContext, payload: dict[str, Any]) -> dict[str, Any]:
        actual_payload = payload.get("context") if isinstance(payload.get("context"), dict) else {}
        actual = TurnContext.from_dict(actual_payload)
        mismatch = expected.mismatch_reason(actual)
        if mismatch is not None:
            raise StaleRuntimeResult(mismatch)
        return payload


__all__ = ["PerformerRuntime", "RuntimeExecutionError", "RuntimePaths", "StaleRuntimeResult"]
