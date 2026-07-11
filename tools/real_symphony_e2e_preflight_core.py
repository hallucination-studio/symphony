from __future__ import annotations

import argparse
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from conductor.conductor_runtime_config import sanitize_codex_config_template
from real_symphony_e2e_common import utc_now
from real_symphony_e2e_errors import E2EConfigurationError


CODEX_HOME_SEED_FILES = ("config.toml", "auth.json", "version.json", "models_cache.json")
CODEX_HOME_SEED_ENV = "SYMPHONY_E2E_CODEX_HOME_SEED"
DEFAULT_E2E_HARD_TURN_TIMEOUT_MS = 900_000
_E2E_CODEX_STAGING_PREFIX = "symphony-e2e-codex-"


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
    by_role = {"plan": 1, "work_item": 1, "verify": 1}
    if pipeline_scenario in {"parallel", "integration-conflict", "overall-dod"}:
        by_role["work_item"] = 2
    return {
        "runtime_group_id": runtime_group_id,
        "version": version,
        "managed_run_policy": {
            "policy_id": f"policy-{runtime_group_id}",
            "version": version,
            "effective_at": utc_now(),
            "capacity": {"global": 3, "by_role": by_role},
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
    work_item_settings = dict(settings)
    if pipeline_scenario in {"runtime-wait", "overall-dod"}:
        work_item_settings["emit_runtime_wait_probe"] = True
        work_item_settings["runtime_wait_probe_seconds"] = 90
    verify_settings: dict[str, Any] = {}
    if pipeline_scenario in {"replan", "overall-dod"}:
        verify_settings["force_first_verify_failure_for_replan"] = True
    return {
        "plan": {"name": "codex-plan", "backend": "codex", "role": "plan", "settings": dict(settings)},
        "work_item": {"name": "codex-work-item", "backend": "codex", "role": "work_item", "settings": work_item_settings},
        "verify": {"name": "local-verifier", "backend": "local-verifier", "role": "verify", "settings": verify_settings},
    }


def e2e_codex_home_seed_source() -> Path:
    raw_source = os.environ.get(CODEX_HOME_SEED_ENV, "").strip()
    if not raw_source:
        raise E2EConfigurationError(
            failure_class="environment_failure",
            error_code="managed_codex_home_seed_required",
            sanitized_reason=f"{CODEX_HOME_SEED_ENV} is required and must point to a fixed copied Codex config seed.",
            retryable=False,
            next_action="set_symphony_e2e_codex_home_seed",
        )
    return Path(raw_source)


def stage_codex_home_seed(*, source: Path, destination: Path) -> Path:
    source = source.expanduser().resolve()
    if source.name == ".codex":
        raise _invalid_codex_home_seed(
            "Codex config source must be a fixed copied seed, not the default user .codex directory."
        )
    if not source.is_dir():
        raise _invalid_codex_home_seed("Codex config source is not a directory.")
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    for relative in CODEX_HOME_SEED_FILES:
        _copy_seed_file(source, destination, relative)
    if not (destination / "config.toml").is_file():
        raise _invalid_codex_home_seed("Codex config source is missing config.toml.")
    if not (destination / "auth.json").is_file():
        raise _invalid_codex_home_seed("Codex config source is missing auth.json.")
    return destination


def stage_e2e_codex_home_seed(*, source: Path) -> Path:
    staging_root = Path(tempfile.mkdtemp(prefix=_E2E_CODEX_STAGING_PREFIX))
    staged_home = staging_root / "home"
    try:
        return stage_codex_home_seed(source=source, destination=staged_home)
    except Exception:
        cleanup_staged_codex_home(staged_home)
        raise


def cleanup_staged_codex_home(staged_home: Path | None) -> None:
    if staged_home is None:
        return
    staging_root = staged_home.parent
    if not staging_root.name.startswith(_E2E_CODEX_STAGING_PREFIX):
        raise RuntimeError("Refusing to remove a Codex staging directory without the E2E staging prefix.")
    if staging_root.exists():
        shutil.rmtree(staging_root)


def scrub_e2e_runtime_credentials(data_root: Path | None) -> int:
    if data_root is None or not data_root.exists():
        return 0
    removed = 0
    for auth_path in data_root.rglob("auth.json"):
        if "runtime-homes" not in auth_path.parts:
            continue
        if auth_path.is_file() or auth_path.is_symlink():
            auth_path.unlink()
            removed += 1
    return removed


def _invalid_codex_home_seed(reason: str) -> E2EConfigurationError:
    return E2EConfigurationError(
        failure_class="environment_failure",
        error_code="managed_codex_home_seed_invalid",
        sanitized_reason=reason,
        retryable=False,
        next_action="stage_approved_codex_home_seed",
    )


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
