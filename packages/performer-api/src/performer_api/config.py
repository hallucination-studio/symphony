from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config_utils import (
    ConfigError,
    _bool,
    _int,
    _map,
    _required_positive_int,
    _resolve_env,
    _resolve_path,
    _string,
    load_env_file,
    sanitize_codex_config_template,
)
from .models import normalize_state_key


@dataclass(frozen=True)
class TrackerConfig:
    kind: str
    endpoint: str
    project_slug: str
    api_key: str
    required_delegate_id: str | None = None
    pipeline_labels_enabled: bool = True
    terminal_states: list[str] = field(
        default_factory=lambda: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]
    )


@dataclass(frozen=True)
class WorkspaceConfig:
    root: Path
    per_issue: bool = True


@dataclass(frozen=True)
class HooksConfig:
    after_create: str | None = None
    before_run: str | None = None
    after_run: str | None = None
    before_remove: str | None = None
    timeout_ms: int = 60_000


@dataclass(frozen=True)
class AgentConfig:
    max_concurrent_agents: int = 10
    max_turns: int = 20
    max_retry_backoff_ms: int = 300_000
    max_concurrent_agents_by_state: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class CodexConfig:
    backend: str = "sdk"
    command: str = ""
    model: str | None = None
    sdk_codex_bin: str | None = None
    sandbox: str | None = None
    config_overrides: tuple[str, ...] = ()
    linear_tool_mode: str = "disabled"
    approval_policy: Any = None
    thread_sandbox: Any = None
    turn_sandbox_policy: Any = None
    turn_timeout_ms: int = 3_600_000
    hard_turn_timeout_ms: int = 3_600_000
    read_timeout_ms: int = 5_000
    stall_timeout_ms: int = 300_000
    init_max_attempts: int = 4
    init_backoff_ms: int = 500
    init_backoff_max_ms: int = 8_000
    overload_max_attempts: int = 5
    overload_initial_delay_ms: int = 250
    overload_max_delay_ms: int = 8_000


@dataclass(frozen=True)
class ServerConfig:
    port: int | None = None
    host: str = "127.0.0.1"


@dataclass(frozen=True)
class PersistenceConfig:
    path: Path | None = None


@dataclass(frozen=True)
class ObservabilityConfig:
    enabled: bool = True
    host: str = "127.0.0.1"
    allow_refresh: bool = True


@dataclass(frozen=True)
class WorkerConfig:
    ssh_hosts: list[str] = field(default_factory=list)
    max_concurrent_agents_per_host: int = 1


@dataclass(frozen=True)
class RepositoryHandoffConfig:
    enabled: bool = False
    bundle_root: Path | None = None


@dataclass(frozen=True)
class ServiceConfig:
    tracker: TrackerConfig
    workspace: WorkspaceConfig
    hooks: HooksConfig
    agent: AgentConfig
    codex: CodexConfig
    server: ServerConfig = field(default_factory=ServerConfig)
    persistence: PersistenceConfig = field(default_factory=PersistenceConfig)
    observability: ObservabilityConfig = field(default_factory=ObservabilityConfig)
    worker: WorkerConfig = field(default_factory=WorkerConfig)
    repository_handoff: RepositoryHandoffConfig = field(default_factory=RepositoryHandoffConfig)

    def validate_static(self) -> None:
        if self.tracker.kind == "linear" and not self.tracker.api_key:
            raise ConfigError("missing_tracker_api_key", "tracker.api_key is required")
        if self.tracker.kind == "linear" and not self.tracker.project_slug:
            raise ConfigError("missing_tracker_project_slug", "tracker.project_slug is required")
        if self.codex.backend != "sdk":
            raise ConfigError("invalid_codex_backend", "codex.backend must be sdk")
        if self.codex.linear_tool_mode != "disabled":
            raise ConfigError(
                "invalid_codex_linear_tool_mode",
                "codex.linear_tool_mode must be disabled",
            )

    def validate_for_dispatch(self) -> None:
        self.validate_static()


def _tracker_config(raw: dict[str, Any], base_path: Path) -> TrackerConfig:
    kind = _string(raw.get("kind"), "linear") or "linear"
    endpoint = _string(raw.get("endpoint"), "https://api.linear.app/graphql") or ""
    config = TrackerConfig(
        kind=kind,
        endpoint=endpoint,
        project_slug=_string(raw.get("project_slug"), "") or "",
        api_key=_resolve_env(_string(raw.get("api_key"))) or "",
        required_delegate_id=_resolve_env(_string(raw.get("required_delegate_id"))),
        pipeline_labels_enabled=_bool(raw.get("pipeline_labels_enabled"), True),
        terminal_states=list(
            raw.get("terminal_states") or ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]
        ),
    )
    _ = base_path
    _validate_tracker(config)
    return config


def _validate_tracker(config: TrackerConfig) -> None:
    if config.kind == "linear" and not config.api_key:
        raise ConfigError("missing_tracker_api_key", "tracker.api_key is required")
    if config.kind == "linear" and not config.project_slug:
        raise ConfigError("missing_tracker_project_slug", "tracker.project_slug is required")


def _workspace_config(raw: dict[str, Any], base_path: Path) -> WorkspaceConfig:
    return WorkspaceConfig(
        root=_resolve_path(_string(raw.get("root")), base_path),
        per_issue=_bool(raw.get("per_issue"), True),
    )


def _hooks_config(raw: dict[str, Any]) -> HooksConfig:
    timeout_ms = _required_positive_int(raw.get("timeout_ms"), 60_000, "invalid_hook_timeout_ms")
    return HooksConfig(
        after_create=_string(raw.get("after_create")),
        before_run=_string(raw.get("before_run")),
        after_run=_string(raw.get("after_run")),
        before_remove=_string(raw.get("before_remove")),
        timeout_ms=timeout_ms,
    )


def _agent_config(raw: dict[str, Any]) -> AgentConfig:
    per_state: dict[str, int] = {}
    for state, value in _map(raw.get("max_concurrent_agents_by_state")).items():
        limit = _int(value, 0, positive=True)
        if limit > 0:
            per_state[normalize_state_key(str(state))] = limit
    return AgentConfig(
        max_concurrent_agents=_int(raw.get("max_concurrent_agents"), 10, positive=True),
        max_turns=_required_positive_int(raw.get("max_turns"), 20, "invalid_agent_max_turns"),
        max_retry_backoff_ms=_int(raw.get("max_retry_backoff_ms"), 300_000, positive=True),
        max_concurrent_agents_by_state=per_state,
    )


def _codex_config(raw: dict[str, Any]) -> CodexConfig:
    return CodexConfig(
        backend=_string(raw.get("backend"), "sdk") or "sdk",
        command=_string(raw.get("command"), "") or "",
        model=_string(raw.get("model")),
        sdk_codex_bin=_string(raw.get("sdk_codex_bin")),
        sandbox=_string(raw.get("sandbox")),
        config_overrides=_codex_config_overrides(raw.get("config_overrides")),
        linear_tool_mode=_string(raw.get("linear_tool_mode"), "disabled") or "disabled",
        approval_policy=raw.get("approval_policy"),
        thread_sandbox=raw.get("thread_sandbox"),
        turn_sandbox_policy=raw.get("turn_sandbox_policy"),
        turn_timeout_ms=_int(raw.get("turn_timeout_ms"), 3_600_000),
        hard_turn_timeout_ms=_int(raw.get("hard_turn_timeout_ms"), _int(raw.get("turn_timeout_ms"), 3_600_000)),
        read_timeout_ms=_int(raw.get("read_timeout_ms"), 5_000, positive=True),
        stall_timeout_ms=_int(raw.get("stall_timeout_ms"), 300_000),
        init_max_attempts=_int(raw.get("init_max_attempts"), 4, positive=True),
        init_backoff_ms=_int(raw.get("init_backoff_ms"), 500, positive=True),
        init_backoff_max_ms=_int(raw.get("init_backoff_max_ms"), 8_000, positive=True),
        overload_max_attempts=_int(raw.get("overload_max_attempts"), 5, positive=True),
        overload_initial_delay_ms=_int(raw.get("overload_initial_delay_ms"), 250, positive=True),
        overload_max_delay_ms=_int(raw.get("overload_max_delay_ms"), 8_000, positive=True),
    )


def _codex_config_overrides(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise ConfigError("invalid_codex_config_override", "codex.config_overrides must be a list of KEY=VALUE strings")
    overrides: list[str] = []
    for item in value:
        text = str(item).strip()
        if not text or "=" not in text:
            raise ConfigError("invalid_codex_config_override", "codex.config_overrides entries must be KEY=VALUE strings")
        key, raw_value = text.split("=", 1)
        if not key.strip() or raw_value == "":
            raise ConfigError("invalid_codex_config_override", "codex.config_overrides entries must have non-empty keys and values")
        lowered_key = key.lower()
        if any(marker in lowered_key for marker in ("api_key", "apikey", "token", "secret", "password")):
            stripped_value = raw_value.strip()
            if not stripped_value.startswith("$"):
                raise ConfigError("unsafe_codex_config_override", "secret-bearing codex.config_overrides values must use $VAR indirection")
        overrides.append(text)
    return tuple(overrides)


def _server_config(raw: dict[str, Any]) -> ServerConfig:
    port = raw.get("port")
    parsed_port = None if port is None else _int(port, 0)
    if parsed_port is not None and parsed_port < 0:
        parsed_port = None
    return ServerConfig(
        port=parsed_port,
        host=_string(raw.get("host"), "127.0.0.1") or "127.0.0.1",
    )


def _persistence_config(raw: dict[str, Any], base_path: Path) -> PersistenceConfig:
    raw_path = _string(raw.get("path"))
    if raw_path is None or not raw_path.strip():
        return PersistenceConfig()
    return PersistenceConfig(path=_resolve_path(raw_path, base_path))


def _observability_config(raw: dict[str, Any]) -> ObservabilityConfig:
    return ObservabilityConfig(
        enabled=_bool(raw.get("enabled"), True),
        host=_string(raw.get("host"), "127.0.0.1") or "127.0.0.1",
        allow_refresh=_bool(raw.get("allow_refresh"), True),
    )


def _worker_config(raw: dict[str, Any]) -> WorkerConfig:
    hosts = [str(host).strip() for host in (raw.get("ssh_hosts") or [])]
    hosts = [host for host in hosts if host]
    return WorkerConfig(
        ssh_hosts=hosts,
        max_concurrent_agents_per_host=_required_positive_int(
            raw.get("max_concurrent_agents_per_host"),
            1,
            "invalid_worker_max_concurrent_agents_per_host",
        ),
    )


def _repository_handoff_config(raw: dict[str, Any], base_path: Path) -> RepositoryHandoffConfig:
    return RepositoryHandoffConfig(
        enabled=_bool(raw.get("enabled"), False),
        bundle_root=(
            _resolve_path(_string(raw.get("bundle_root")), base_path)
            if _string(raw.get("bundle_root"))
            else None
        ),
    )
