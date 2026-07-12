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


_CODEX_ENV_KEYS = (
    "CODEX_MODEL",
    "CODEX_SDK_CODEX_BIN",
    "CODEX_SANDBOX",
    "CODEX_CONFIG_OVERRIDES",
    "CODEX_HARD_TURN_TIMEOUT_MS",
    "CODEX_READ_TIMEOUT_MS",
    "CODEX_INIT_MAX_ATTEMPTS",
    "CODEX_INIT_BACKOFF_MS",
    "CODEX_INIT_BACKOFF_MAX_MS",
    "CODEX_OVERLOAD_MAX_ATTEMPTS",
    "CODEX_OVERLOAD_INITIAL_DELAY_MS",
    "CODEX_OVERLOAD_MAX_DELAY_MS",
)
_CODEX_CONFIG_ALLOWED_TOP_LEVEL_KEYS = {
    "model_provider",
    "model",
    "disable_response_storage",
    "model_reasoning_effort",
    "approval_policy",
    "approvals_reviewer",
    "sandbox_mode",
    "service_tier",
    "plan_mode_reasoning_effort",
}
_CODEX_CONFIG_ALLOWED_SECTION_PREFIXES = (
    "model_providers",
    "sandbox_workspace_write",
)


@dataclass(frozen=True)
class RuntimePaths:
    root: Path
    request: Path
    result: Path
    log: Path


class PerformerRuntime:
    ALLOWED_CODEX_SEED_FILES = ("config.toml", "auth.json", "version.json", "models_cache.json")

    def __init__(self, performer_command: Sequence[str] = ("performer",)) -> None:
        self.performer_command = tuple(performer_command)

    def prepare_environment(
        self,
        instance_state_root: Path,
        *,
        workspace_path: Path | str | None = None,
        home_scope: str | None = None,
    ) -> dict[str, str]:
        codex_home = instance_state_root / "runtime-homes" / _safe_scope(home_scope or "attempt") / "codex"
        try:
            codex_home.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ValueError(f"isolated CODEX_HOME could not be materialized: {codex_home}") from exc
        if not codex_home.is_dir():
            raise ValueError(f"isolated CODEX_HOME could not be materialized: {codex_home}")

        source = _codex_seed_from_environment()
        if source is not None:
            self._copy_codex_home_seed(source, codex_home)
        if workspace_path is not None:
            _trust_codex_project(codex_home / "config.toml", Path(workspace_path))

        environment = {"CODEX_HOME": str(codex_home)}
        for key in _CODEX_ENV_KEYS:
            value = os.environ.get(key)
            if value:
                environment[key] = value
        return environment

    def _copy_codex_home_seed(self, source: Path, destination: Path) -> None:
        for name in self.ALLOWED_CODEX_SEED_FILES:
            source_path = source / name
            if not source_path.is_file():
                continue
            destination_path = destination / name
            if name == "config.toml":
                destination_path.write_text(
                    _sanitize_codex_config_template(source_path.read_text(encoding="utf-8")),
                    encoding="utf-8",
                )
            else:
                shutil.copy2(source_path, destination_path)

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


def _codex_seed_from_environment() -> Path | None:
    raw = (os.environ.get("SYMPHONY_E2E_CODEX_HOME_SEED") or os.environ.get("CODEX_HOME_SOURCE") or "").strip()
    if not raw:
        return None
    if raw.startswith("$"):
        raw = os.environ.get(raw[1:], "").strip()
    if not raw:
        return None
    source = Path(raw).expanduser().resolve()
    if source.name == ".codex":
        raise ValueError("Codex seed must be a fixed copied directory, not ~/.codex")
    if not source.is_dir():
        raise ValueError(f"Codex seed is not a directory: {source}")
    return source


def _trust_codex_project(config_path: Path, workspace_path: Path) -> None:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    workspace = str(workspace_path.expanduser().resolve())
    header = f"[projects.{json.dumps(workspace)}]"
    existing = config_path.read_text(encoding="utf-8") if config_path.exists() else ""
    if header in existing:
        return
    suffix = "" if not existing or existing.endswith("\n") else "\n"
    config_path.write_text(f"{existing}{suffix}\n{header}\ntrust_level = \"trusted\"\n", encoding="utf-8")


def _safe_scope(value: Any) -> str:
    return "".join(char if char.isalnum() or char in {"-", "_"} else "_" for char in str(value))[:160] or "attempt"


def _sanitize_codex_config_template(text: str) -> str:
    output: list[str] = []
    keep_section = True
    current_section: str | None = None
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            current_section = stripped.strip("[]")
            keep_section = any(
                current_section == prefix or current_section.startswith(f"{prefix}.")
                for prefix in _CODEX_CONFIG_ALLOWED_SECTION_PREFIXES
            )
            if keep_section:
                _append_config_line(output, line)
        elif current_section is None:
            _append_allowed_top_level_config_line(output, line, stripped)
        elif keep_section:
            _append_config_line(output, line)
    while output and not output[-1].strip():
        output.pop()
    return "\n".join(output) + ("\n" if output else "")


def _append_allowed_top_level_config_line(output: list[str], line: str, stripped: str) -> None:
    if not stripped or stripped.startswith("#"):
        _append_config_line(output, line)
        return
    key = stripped.split("=", 1)[0].strip() if "=" in stripped else ""
    if key in _CODEX_CONFIG_ALLOWED_TOP_LEVEL_KEYS:
        _append_config_line(output, line)


def _append_config_line(output: list[str], line: str) -> None:
    if not line.strip() and (not output or not output[-1].strip()):
        return
    output.append(line)


__all__ = ["PerformerRuntime", "RuntimeExecutionError", "RuntimePaths", "StaleRuntimeResult"]
