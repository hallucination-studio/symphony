from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .models import normalize_labels, normalize_state_key
from .workflow import WorkflowDefinition


class ConfigError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class TrackerConfig:
    kind: str
    endpoint: str
    project_slug: str
    api_key: str
    assignee_id: str | None = None
    required_labels: list[str] = field(default_factory=list)
    active_states: list[str] = field(default_factory=lambda: ["Todo", "In Progress"])
    terminal_states: list[str] = field(
        default_factory=lambda: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]
    )


@dataclass(frozen=True)
class PollingConfig:
    interval_ms: int = 30_000


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
    command: str = "codex app-server"
    approval_policy: Any = None
    thread_sandbox: Any = None
    turn_sandbox_policy: Any = None
    turn_timeout_ms: int = 3_600_000
    read_timeout_ms: int = 5_000
    stall_timeout_ms: int = 300_000


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
class CompletionVerificationConfig:
    """完成验证配置"""

    enabled: bool = True
    required_checks: list[str] = field(
        default_factory=lambda: ["workspace_changes", "test_command_evidence", "metrics_reasonable"]
    )
    optional_checks: list[str] = field(default_factory=lambda: ["test_results", "linear_state"])
    expected_repo_root: str | None = None
    expected_test_patterns: list[str] = field(default_factory=list)
    auto_retry_on_fail: bool = True
    max_verification_retries: int = 1
    test_timeout_seconds: int = 60
    min_duration_seconds: int = 5
    min_workspace_changes_chars: int = 50


@dataclass(frozen=True)
class ServiceConfig:
    tracker: TrackerConfig
    polling: PollingConfig
    workspace: WorkspaceConfig
    hooks: HooksConfig
    agent: AgentConfig
    codex: CodexConfig
    prompt_template: str
    workflow_path: Path
    server: ServerConfig = field(default_factory=ServerConfig)
    persistence: PersistenceConfig = field(default_factory=PersistenceConfig)
    observability: ObservabilityConfig = field(default_factory=ObservabilityConfig)
    worker: WorkerConfig = field(default_factory=WorkerConfig)
    completion_verification: CompletionVerificationConfig = field(
        default_factory=CompletionVerificationConfig
    )

    @classmethod
    def from_workflow(cls, workflow: WorkflowDefinition, workflow_path: Path) -> ServiceConfig:
        raw = workflow.config
        tracker = _tracker_config(_map(raw.get("tracker")), workflow_path)
        return cls(
            tracker=tracker,
            polling=_polling_config(_map(raw.get("polling"))),
            workspace=_workspace_config(_map(raw.get("workspace")), workflow_path),
            hooks=_hooks_config(_map(raw.get("hooks"))),
            agent=_agent_config(_map(raw.get("agent"))),
            codex=_codex_config(_map(raw.get("codex"))),
            server=_server_config(_map(raw.get("server"))),
            persistence=_persistence_config(_map(raw.get("persistence")), workflow_path),
            observability=_observability_config(_map(raw.get("observability"))),
            worker=_worker_config(_map(raw.get("worker"))),
            completion_verification=_completion_verification_config(
                _map(raw.get("completion_verification")),
                workflow_path,
            ),
            prompt_template=workflow.prompt_template,
            workflow_path=workflow_path,
        )

    def validate_for_dispatch(self) -> None:
        from .tracker import is_registered_tracker_kind

        if not is_registered_tracker_kind(self.tracker.kind):
            raise ConfigError("unsupported_tracker_kind", f"Unsupported tracker kind: {self.tracker.kind}")
        if self.tracker.kind == "linear" and not self.tracker.api_key:
            raise ConfigError("missing_tracker_api_key", "tracker.api_key is required")
        if self.tracker.kind == "linear" and not self.tracker.project_slug:
            raise ConfigError("missing_tracker_project_slug", "tracker.project_slug is required")
        if not self.codex.command.strip():
            raise ConfigError("missing_codex_command", "codex.command is required")


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        os.environ[key] = value.strip().strip("\"'")


def _map(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _string(value: Any, default: str | None = None) -> str | None:
    if value is None:
        return default
    if isinstance(value, str):
        return value
    return str(value)


def _int(value: Any, default: int, *, positive: bool = False) -> int:
    if value is None:
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    if positive and parsed <= 0:
        return default
    return parsed


def _bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _resolve_env(value: str | None) -> str | None:
    if value is None:
        return None
    if value.startswith("$") and len(value) > 1:
        return os.environ.get(value[1:]) or None
    return value


def _resolve_path(value: str | None, workflow_path: Path) -> Path:
    raw = _resolve_env(value) if value is not None else None
    if not raw:
        raw = str(Path(tempfile.gettempdir()) / "symphony_workspaces")
    expanded = Path(os.path.expanduser(raw))
    if not expanded.is_absolute():
        expanded = workflow_path.parent / expanded
    return expanded.resolve()


def _tracker_config(raw: dict[str, Any], workflow_path: Path) -> TrackerConfig:
    kind = _string(raw.get("kind"), "linear") or "linear"
    endpoint = _string(raw.get("endpoint"), "https://api.linear.app/graphql") or ""
    config = TrackerConfig(
        kind=kind,
        endpoint=endpoint,
        project_slug=_string(raw.get("project_slug"), "") or "",
        api_key=_resolve_env(_string(raw.get("api_key"))) or "",
        assignee_id=_resolve_env(_string(raw.get("assignee_id"))),
        required_labels=_normalize_required_labels(raw.get("required_labels") or []),
        active_states=list(raw.get("active_states") or ["Todo", "In Progress"]),
        terminal_states=list(
            raw.get("terminal_states") or ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]
        ),
    )
    _ = workflow_path
    _validate_tracker(config)
    return config


def _validate_tracker(config: TrackerConfig) -> None:
    if config.kind == "linear" and not config.api_key:
        raise ConfigError("missing_tracker_api_key", "tracker.api_key is required")
    if config.kind == "linear" and not config.project_slug:
        raise ConfigError("missing_tracker_project_slug", "tracker.project_slug is required")


def _normalize_required_labels(labels: list[str] | None) -> list[str]:
    if not labels:
        return []
    return [str(label).strip().lower() for label in labels]


def _polling_config(raw: dict[str, Any]) -> PollingConfig:
    return PollingConfig(interval_ms=_int(raw.get("interval_ms"), 30_000, positive=True))


def _workspace_config(raw: dict[str, Any], workflow_path: Path) -> WorkspaceConfig:
    return WorkspaceConfig(
        root=_resolve_path(_string(raw.get("root")), workflow_path),
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


def _required_positive_int(value: Any, default: int, code: str) -> int:
    if value is None:
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError(code, f"Expected a positive integer for {code}") from exc
    if parsed <= 0:
        raise ConfigError(code, f"Expected a positive integer for {code}")
    return parsed


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
        command=_string(raw.get("command"), "codex app-server") or "",
        approval_policy=raw.get("approval_policy"),
        thread_sandbox=raw.get("thread_sandbox"),
        turn_sandbox_policy=raw.get("turn_sandbox_policy"),
        turn_timeout_ms=_int(raw.get("turn_timeout_ms"), 3_600_000, positive=True),
        read_timeout_ms=_int(raw.get("read_timeout_ms"), 5_000, positive=True),
        stall_timeout_ms=_int(raw.get("stall_timeout_ms"), 300_000),
    )


def _server_config(raw: dict[str, Any]) -> ServerConfig:
    port = raw.get("port")
    parsed_port = None if port is None else _int(port, 0)
    if parsed_port is not None and parsed_port < 0:
        parsed_port = None
    return ServerConfig(
        port=parsed_port,
        host=_string(raw.get("host"), "127.0.0.1") or "127.0.0.1",
    )


def _persistence_config(raw: dict[str, Any], workflow_path: Path) -> PersistenceConfig:
    raw_path = _string(raw.get("path"))
    if raw_path is None or not raw_path.strip():
        return PersistenceConfig()
    return PersistenceConfig(path=_resolve_path(raw_path, workflow_path))


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


def _string_list(value: Any, default: list[str]) -> list[str]:
    if value is None:
        return list(default)
    if not isinstance(value, list):
        return list(default)
    return [str(item).strip() for item in value if str(item).strip()]


def _completion_verification_config(raw: dict[str, Any], workflow_path: Path) -> CompletionVerificationConfig:
    defaults = CompletionVerificationConfig()
    expected_repo_root = _string(raw.get("expected_repo_root"), defaults.expected_repo_root)
    if expected_repo_root:
        expected_repo_root = str(_resolve_path(expected_repo_root, workflow_path))
    return CompletionVerificationConfig(
        enabled=_bool(raw.get("enabled"), defaults.enabled),
        required_checks=_string_list(raw.get("required_checks"), defaults.required_checks),
        optional_checks=_string_list(raw.get("optional_checks"), defaults.optional_checks),
        expected_repo_root=expected_repo_root,
        expected_test_patterns=_string_list(raw.get("expected_test_patterns"), defaults.expected_test_patterns),
        auto_retry_on_fail=_bool(raw.get("auto_retry_on_fail"), defaults.auto_retry_on_fail),
        max_verification_retries=_int(
            raw.get("max_verification_retries"),
            defaults.max_verification_retries,
            positive=True,
        ),
        test_timeout_seconds=_required_positive_int(
            raw.get("test_timeout_seconds"),
            defaults.test_timeout_seconds,
            "invalid_completion_verification_test_timeout_seconds",
        ),
        min_duration_seconds=_int(raw.get("min_duration_seconds"), defaults.min_duration_seconds),
        min_workspace_changes_chars=_int(
            raw.get("min_workspace_changes_chars"),
            defaults.min_workspace_changes_chars,
            positive=True,
        ),
    )
