from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from performer_api.config import sanitize_codex_config_template
from performer_api.managed_runs import ManagedRunRuntimeRole, RuntimeProfile


@dataclass(frozen=True)
class BackendEnvironmentContext:
    instance_state_root: Path
    profile: RuntimeProfile
    workspace_path: Path | None = None
    home_scope: str | None = None


class RuntimeBackendProvider(Protocol):
    name: str

    def prepare_environment(self, context: BackendEnvironmentContext) -> dict[str, str]:
        ...


class RuntimeBackendRegistry:
    def __init__(self, providers: list[RuntimeBackendProvider]):
        self._providers = {provider.name: provider for provider in providers}

    def prepare_environment(
        self,
        instance_state_root: Path,
        profile: RuntimeProfile | None,
        *,
        workspace_path: Path | str | None = None,
        home_scope: str | None = None,
    ) -> dict[str, str]:
        if profile is None:
            raise ValueError("runtime profile is required for managed mode attempts")
        provider = self._providers.get(profile.backend)
        if provider is None:
            raise ValueError(f"unsupported runtime backend for {profile.role.value}: {profile.backend}")
        workspace = Path(workspace_path) if workspace_path is not None else None
        return provider.prepare_environment(
            BackendEnvironmentContext(
                instance_state_root=instance_state_root,
                profile=profile,
                workspace_path=workspace,
                home_scope=home_scope,
            )
        )


class CodexRuntimeBackendProvider:
    name = "codex"

    def prepare_environment(self, context: BackendEnvironmentContext) -> dict[str, str]:
        profile = context.profile
        codex_home = _runtime_home_root(context, "codex")
        try:
            codex_home.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ValueError(f"isolated CODEX_HOME could not be materialized: {codex_home}") from exc
        if not codex_home.is_dir():
            raise ValueError(f"isolated CODEX_HOME could not be materialized: {codex_home}")
        source = _resolve_codex_home_source(profile.settings.get("codex_home_source"))
        if source is not None:
            _copy_codex_home_seed(source, codex_home)
        if context.workspace_path is not None:
            _trust_codex_project(codex_home / "config.toml", context.workspace_path)
        env = {"CODEX_HOME": str(codex_home)}
        model = profile.settings.get("model")
        if model is not None:
            env["CODEX_MODEL"] = str(model)
        for key in (
            "sdk_codex_bin",
            "sandbox",
            "hard_turn_timeout_ms",
            "read_timeout_ms",
            "init_max_attempts",
            "init_backoff_ms",
            "init_backoff_max_ms",
            "overload_max_attempts",
            "overload_initial_delay_ms",
            "overload_max_delay_ms",
            "emit_runtime_wait_probe",
            "runtime_wait_probe_seconds",
        ):
            value = profile.settings.get(key)
            if value is not None:
                env[f"CODEX_{key.upper()}"] = str(value)
        config_overrides = profile.settings.get("config_overrides")
        if isinstance(config_overrides, list):
            env["CODEX_CONFIG_OVERRIDES"] = json.dumps([str(item) for item in config_overrides])
        return env


class LocalVerifierRuntimeBackendProvider:
    name = "local-verifier"

    def prepare_environment(self, context: BackendEnvironmentContext) -> dict[str, str]:
        profile = context.profile
        if profile.role is not ManagedRunRuntimeRole.VERIFY:
            raise ValueError(f"unsupported runtime backend for {profile.role.value}: {profile.backend}")
        verifier_home = _runtime_home_root(context, "local-verifier")
        try:
            verifier_home.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ValueError(f"isolated local verifier home could not be materialized: {verifier_home}") from exc
        if not verifier_home.is_dir():
            raise ValueError(f"isolated local verifier home could not be materialized: {verifier_home}")
        env = {"SYMPHONY_LOCAL_VERIFIER_HOME": str(verifier_home)}
        if profile.settings.get("force_first_verify_failure_for_replan") is True:
            probe_home = _runtime_mode_home_root(context) / "local-verifier"
            probe_home.mkdir(parents=True, exist_ok=True)
            env["SYMPHONY_FORCE_FIRST_VERIFY_FAILURE_FOR_REPLAN"] = "1"
            env["SYMPHONY_LOCAL_VERIFIER_PROBE_HOME"] = str(probe_home)
        return env


def default_runtime_backend_registry() -> RuntimeBackendRegistry:
    return RuntimeBackendRegistry([CodexRuntimeBackendProvider(), LocalVerifierRuntimeBackendProvider()])


def prepare_backend_environment(
    instance_state_root: Path,
    profile: RuntimeProfile | None,
    *,
    workspace_path: Path | str | None = None,
    home_scope: str | None = None,
) -> dict[str, str]:
    return default_runtime_backend_registry().prepare_environment(
        instance_state_root,
        profile,
        workspace_path=workspace_path,
        home_scope=home_scope,
    )


def _runtime_home_root(context: BackendEnvironmentContext, backend_name: str) -> Path:
    base = _runtime_mode_home_root(context)
    if context.home_scope:
        return base / _safe_home_scope(context.home_scope) / backend_name
    return base / backend_name


def _runtime_mode_home_root(context: BackendEnvironmentContext) -> Path:
    return context.instance_state_root / "runtime-homes" / context.profile.role.value


def _safe_home_scope(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in value)[:160] or "attempt"


def _resolve_codex_home_source(value: Any) -> Path | None:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if not raw.startswith("$"):
        raise ValueError("codex_home_source must be injected through an environment variable")
    env_name = raw[1:]
    if not env_name:
        raise ValueError("codex_home_source environment variable name is empty")
    raw = os.environ.get(env_name, "").strip()
    if not raw:
        raise ValueError(f"codex_home_source environment variable is not set: {env_name}")
    source = Path(raw).expanduser().resolve()
    if source.name == ".codex":
        raise ValueError("codex_home_source must point to a fixed copied seed, not the default user .codex directory")
    if not source.is_dir():
        raise ValueError(f"codex_home_source is not a directory: {source}")
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
