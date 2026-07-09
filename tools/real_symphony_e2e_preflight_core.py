from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path
from typing import Any

from performer_api.config import sanitize_codex_config_template
from real_symphony_e2e_common import utc_now


CODEX_HOME_SEED_FILES = ("config.toml", "auth.json", "version.json", "models_cache.json")
CODEX_HOME_SEED_ENV = "SYMPHONY_E2E_CODEX_HOME_SEED"
DEFAULT_E2E_HARD_TURN_TIMEOUT_MS = 900_000


def build_runtime_config_payload(
    *,
    runtime_group_id: str,
    version: int,
    model: str | None = None,
    codex_home_source: str | None = None,
    codex_settings: dict[str, Any] | None = None,
    pipeline_scenario: str = "basic",
) -> dict[str, Any]:
    settings = _base_codex_settings(model, codex_home_source, codex_settings)
    by_mode = {"plan": 1, "execute": 1, "verify": 1}
    if pipeline_scenario in {"parallel", "integration-conflict", "overall-dod"}:
        by_mode["execute"] = 2
    return {
        "runtime_group_id": runtime_group_id,
        "version": version,
        "scheduler_policy": {
            "policy_id": f"policy-{runtime_group_id}",
            "version": version,
            "effective_at": utc_now(),
            "capacity": {"global": 3, "by_mode": by_mode},
            "max_rework_attempts": 1,
        },
        "profiles": _runtime_profiles(settings, pipeline_scenario),
    }


def _base_codex_settings(
    model: str | None,
    codex_home_source: str | None,
    codex_settings: dict[str, Any] | None,
) -> dict[str, Any]:
    settings = dict(codex_settings or {})
    model_name = (model or os.environ.get("SYMPHONY_E2E_CODEX_MODEL") or "").strip()
    if model_name:
        settings["model"] = model_name
    if codex_home_source:
        settings["codex_home_source"] = codex_home_source
    return settings


def _runtime_profiles(settings: dict[str, Any], pipeline_scenario: str) -> dict[str, dict[str, Any]]:
    execute_settings = dict(settings)
    if pipeline_scenario in {"runtime-wait", "overall-dod"}:
        execute_settings["emit_runtime_wait_probe"] = True
        execute_settings["runtime_wait_probe_seconds"] = 90
    verify_settings: dict[str, Any] = {}
    if pipeline_scenario in {"replan", "overall-dod"}:
        verify_settings["force_first_verify_failure_for_replan"] = True
    return {
        "plan": {"name": "codex-plan", "backend": "codex", "mode": "plan", "settings": dict(settings)},
        "execute": {"name": "codex-execute", "backend": "codex", "mode": "execute", "settings": execute_settings},
        "verify": {"name": "local-verifier", "backend": "local-verifier", "mode": "verify", "settings": verify_settings},
    }


def e2e_codex_home_seed_source() -> Path:
    raw_source = os.environ.get(CODEX_HOME_SEED_ENV, "").strip()
    if not raw_source:
        raise RuntimeError(
            f"{CODEX_HOME_SEED_ENV} is required and must point to a fixed copied Codex config seed. "
            "Do not point real-run E2E at the default user .codex directory."
        )
    return Path(raw_source)


def stage_codex_home_seed(*, source: Path, destination: Path) -> Path:
    source = source.expanduser().resolve()
    if source.name == ".codex":
        raise RuntimeError(f"Codex config source must be a fixed copied seed, not the default user .codex directory: {source}")
    if not source.is_dir():
        raise RuntimeError(f"Codex config source is not a directory: {source}")
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    for relative in CODEX_HOME_SEED_FILES:
        _copy_seed_file(source, destination, relative)
    if not (destination / "config.toml").is_file():
        raise RuntimeError(f"Codex config source is missing config.toml: {source}")
    if not (destination / "auth.json").is_file():
        raise RuntimeError(f"Codex config source is missing auth.json: {source}")
    return destination


def _copy_seed_file(source: Path, destination: Path, relative: str) -> None:
    source_path = source / relative
    if not source_path.is_file():
        return
    destination_path = destination / relative
    if relative == "config.toml":
        destination_path.write_text(sanitize_codex_config_template(source_path.read_text(encoding="utf-8")), encoding="utf-8")
    else:
        shutil.copy2(source_path, destination_path)


def _codex_settings_from_args(args: argparse.Namespace) -> dict[str, Any]:
    settings: dict[str, Any] = {"hard_turn_timeout_ms": DEFAULT_E2E_HARD_TURN_TIMEOUT_MS}
    for arg_name in (
        "sdk_codex_bin",
        "init_max_attempts",
        "init_backoff_ms",
        "init_backoff_max_ms",
        "read_timeout_ms",
        "hard_turn_timeout_ms",
        "overload_max_attempts",
        "overload_initial_delay_ms",
        "overload_max_delay_ms",
    ):
        value = getattr(args, arg_name, None)
        if value is not None:
            settings[arg_name] = value
    if getattr(args, "config_override", None):
        settings["config_overrides"] = list(args.config_override)
    return settings
