from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

from .conductor_runtime_config import sanitize_codex_config_template


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


def prepare_codex_environment(
    instance_state_root: Path,
    *,
    workspace_path: Path | str | None = None,
    home_scope: str | None = None,
) -> dict[str, str]:
    """Create one isolated Codex home for a single fenced attempt.

    The seed is deliberately supplied by the Conductor environment. It is never
    discovered from the user's default ``~/.codex`` directory.
    """
    codex_home = instance_state_root / "runtime-homes" / _safe_scope(home_scope or "attempt") / "codex"
    try:
        codex_home.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ValueError(f"isolated CODEX_HOME could not be materialized: {codex_home}") from exc
    if not codex_home.is_dir():
        raise ValueError(f"isolated CODEX_HOME could not be materialized: {codex_home}")

    source = _codex_seed_from_environment()
    if source is not None:
        _copy_codex_home_seed(source, codex_home)
    if workspace_path is not None:
        _trust_codex_project(codex_home / "config.toml", Path(workspace_path))

    env = {"CODEX_HOME": str(codex_home)}
    for key in _CODEX_ENV_KEYS:
        value = os.environ.get(key)
        if value:
            env[key] = value
    return env


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


def _copy_codex_home_seed(source: Path, destination: Path) -> None:
    for relative in ("config.toml", "auth.json", "version.json", "models_cache.json"):
        source_path = source / relative
        if not source_path.is_file():
            continue
        destination_path = destination / relative
        destination_path.parent.mkdir(parents=True, exist_ok=True)
        if relative == "config.toml":
            destination_path.write_text(
                sanitize_codex_config_template(source_path.read_text(encoding="utf-8")),
                encoding="utf-8",
            )
        else:
            shutil.copy2(source_path, destination_path)


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
    return "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in str(value))[:160] or "attempt"


__all__ = ["prepare_codex_environment"]
