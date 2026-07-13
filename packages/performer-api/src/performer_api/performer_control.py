"""Closed provider-neutral contracts for Performer live control."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from performer_api._wire_safety import (
    exact_keys as _exact_keys,
    identifier as _identifier,
    json_copy as _json_copy,
    positive_int as _positive_int,
    safe_text as _safe_text,
    sha256 as _sha256,
)
from performer_api.runtime_policy import RuntimePolicy, RuntimePolicyError, canonical_sha256
from performer_api.turns import TURN_KINDS


CONTROL_PROTOCOL_VERSION = 1
MAX_CONTROL_TEXT_BYTES = 64 * 1024
MAX_SECRET_INPUT_BYTES = 64 * 1024
CONTROL_OPERATIONS = frozenset(
    {
        "performer.status",
        "performer.login",
        "performer.session.delete",
        "performer.config.read",
        "performer.config.write",
        "performer.check",
    }
)
PERFORMER_KINDS = frozenset({"codex"})
LOGIN_METHODS = frozenset({"device_code", "api_key"})
EDITABLE_SETTINGS = frozenset({"api_base_url"})
READINESS_STATUSES = frozenset({"unchecked", "checking", "ready", "failed"})
CHECK_STATUSES = frozenset({"none", "passed", "failed"})
LOGIN_STATUSES = frozenset({"idle", "pending", "succeeded", "failed", "lost"})
ACCOUNT_STATUSES = frozenset({"authenticated", "logged_out", "unknown"})
CONTROL_RESULT_STATUSES = frozenset({"succeeded", "failed"})
CONTROL_EVENT_KINDS = frozenset(
    {"login.pending", "login.succeeded", "login.failed", "control.heartbeat"}
)
_SESSION_DELETE_ACTIONS = frozenset({"cancel_login", "logout"})
_SECRET_INPUT_KINDS = frozenset({"api_key"})


@dataclass(frozen=True)
class PerformerSecretInput:
    kind: str
    length: int

    def __post_init__(self) -> None:
        if self.kind not in _SECRET_INPUT_KINDS:
            raise ValueError("secret input kind is unsupported")
        if isinstance(self.length, bool) or not isinstance(self.length, int):
            raise ValueError("secret input length must be an integer")
        if not 1 <= self.length <= MAX_SECRET_INPUT_BYTES:
            raise ValueError("secret input length is out of bounds")

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "length": self.length}

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PerformerSecretInput":
        _exact_keys(payload, {"kind", "length"}, "secret input")
        return cls(kind=payload.get("kind"), length=payload.get("length"))


@dataclass(frozen=True)
class PerformerCapabilities:
    protocol_version: int
    capability_version: int
    performer_kind: str
    display_name: str
    turn_kinds: tuple[str, ...]
    login_methods: tuple[str, ...]
    supports_session_delete: bool
    editable_settings: tuple[str, ...]
    config_source_visible: bool
    check_supported: bool

    def __post_init__(self) -> None:
        _protocol_version(self.protocol_version)
        _positive_int(self.capability_version, "capability_version")
        _performer_kind(self.performer_kind)
        _safe_text(self.display_name, "display_name", max_bytes=100)
        _closed_tuple(self.turn_kinds, TURN_KINDS, "turn_kinds", require_nonempty=True)
        _closed_tuple(self.login_methods, LOGIN_METHODS, "login_methods")
        _boolean(self.supports_session_delete, "supports_session_delete")
        _closed_tuple(self.editable_settings, EDITABLE_SETTINGS, "editable_settings")
        _boolean(self.config_source_visible, "config_source_visible")
        _boolean(self.check_supported, "check_supported")

    def to_dict(self) -> dict[str, Any]:
        return {
            "protocol_version": self.protocol_version,
            "capability_version": self.capability_version,
            "performer_kind": self.performer_kind,
            "display_name": self.display_name,
            "turn_kinds": list(self.turn_kinds),
            "login_methods": list(self.login_methods),
            "supports_session_delete": self.supports_session_delete,
            "editable_settings": list(self.editable_settings),
            "config_source_visible": self.config_source_visible,
            "check_supported": self.check_supported,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PerformerCapabilities":
        _exact_keys(
            payload,
            {
                "protocol_version",
                "capability_version",
                "performer_kind",
                "display_name",
                "turn_kinds",
                "login_methods",
                "supports_session_delete",
                "editable_settings",
                "config_source_visible",
                "check_supported",
            },
            "capabilities",
        )
        return cls(
            protocol_version=payload.get("protocol_version"),
            capability_version=payload.get("capability_version"),
            performer_kind=payload.get("performer_kind"),
            display_name=payload.get("display_name"),
            turn_kinds=_string_tuple(payload.get("turn_kinds"), "turn_kinds"),
            login_methods=_string_tuple(payload.get("login_methods"), "login_methods"),
            supports_session_delete=payload.get("supports_session_delete"),
            editable_settings=_string_tuple(
                payload.get("editable_settings"), "editable_settings"
            ),
            config_source_visible=payload.get("config_source_visible"),
            check_supported=payload.get("check_supported"),
        )


@dataclass(frozen=True)
class PerformerControlError:
    error_code: str
    sanitized_reason: str
    action_required: bool
    retryable: bool
    attempt_number: int | None
    next_action: str

    def __post_init__(self) -> None:
        _identifier(self.error_code, "error_code")
        _safe_text(self.sanitized_reason, "sanitized_reason", max_bytes=500)
        _boolean(self.action_required, "action_required")
        _boolean(self.retryable, "retryable")
        if self.attempt_number is not None:
            _positive_int(self.attempt_number, "attempt_number")
        _safe_text(self.next_action, "next_action", max_bytes=500)

    def to_dict(self) -> dict[str, Any]:
        return {
            "error_code": self.error_code,
            "sanitized_reason": self.sanitized_reason,
            "action_required": self.action_required,
            "retryable": self.retryable,
            "attempt_number": self.attempt_number,
            "next_action": self.next_action,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PerformerControlError":
        _exact_keys(
            payload,
            {
                "error_code",
                "sanitized_reason",
                "action_required",
                "retryable",
                "attempt_number",
                "next_action",
            },
            "control error",
        )
        return cls(
            error_code=payload.get("error_code"),
            sanitized_reason=payload.get("sanitized_reason"),
            action_required=payload.get("action_required"),
            retryable=payload.get("retryable"),
            attempt_number=payload.get("attempt_number"),
            next_action=payload.get("next_action"),
        )


@dataclass(frozen=True)
class PerformerReadinessState:
    performer_kind: str
    binding_generation: int
    capability_version: int
    execution_policy_sha256: str
    status: str
    last_check_status: str
    error: PerformerControlError | None

    def __post_init__(self) -> None:
        _performer_kind(self.performer_kind)
        _positive_int(self.binding_generation, "binding_generation")
        _positive_int(self.capability_version, "capability_version")
        _sha256(self.execution_policy_sha256, "execution_policy_sha256")
        if self.status not in READINESS_STATUSES:
            raise ValueError("readiness status is unsupported")
        if self.last_check_status not in CHECK_STATUSES:
            raise ValueError("last_check_status is unsupported")
        if self.status == "ready" and self.last_check_status != "passed":
            raise ValueError("ready state requires a passed Check")
        if self.error is not None and not isinstance(self.error, PerformerControlError):
            raise ValueError("readiness error must be a PerformerControlError")
        if self.status == "ready" and self.error is not None:
            raise ValueError("ready state cannot carry an error")
        if self.status == "failed" and self.error is None:
            raise ValueError("failed readiness requires an error")

    def is_compatible(
        self,
        *,
        performer_kind: str,
        binding_generation: int,
        capability_version: int,
        execution_policy_sha256: str,
    ) -> bool:
        return (
            self.status == "ready"
            and self.performer_kind == performer_kind
            and self.binding_generation == binding_generation
            and self.capability_version == capability_version
            and self.execution_policy_sha256 == execution_policy_sha256
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "performer_kind": self.performer_kind,
            "binding_generation": self.binding_generation,
            "capability_version": self.capability_version,
            "execution_policy_sha256": self.execution_policy_sha256,
            "status": self.status,
            "last_check_status": self.last_check_status,
            "error": self.error.to_dict() if self.error is not None else None,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PerformerReadinessState":
        _exact_keys(
            payload,
            {
                "performer_kind",
                "binding_generation",
                "capability_version",
                "execution_policy_sha256",
                "status",
                "last_check_status",
                "error",
            },
            "readiness",
        )
        error_payload = payload.get("error")
        if error_payload is not None and not isinstance(error_payload, dict):
            raise ValueError("readiness error must be an object or null")
        return cls(
            performer_kind=payload.get("performer_kind"),
            binding_generation=payload.get("binding_generation"),
            capability_version=payload.get("capability_version"),
            execution_policy_sha256=payload.get("execution_policy_sha256"),
            status=payload.get("status"),
            last_check_status=payload.get("last_check_status"),
            error=(
                PerformerControlError.from_dict(error_payload)
                if isinstance(error_payload, dict)
                else None
            ),
        )


@dataclass(frozen=True)
class PerformerAccountState:
    status: str
    display_label: str | None

    def __post_init__(self) -> None:
        if self.status not in ACCOUNT_STATUSES:
            raise ValueError("account status is unsupported")
        if self.display_label is not None:
            _safe_text(self.display_label, "display_label", max_bytes=200)

    def to_dict(self) -> dict[str, Any]:
        return {"status": self.status, "display_label": self.display_label}

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PerformerAccountState":
        _exact_keys(payload, {"status", "display_label"}, "account")
        label = payload.get("display_label")
        return cls(
            status=payload.get("status"),
            display_label=label,
        )


@dataclass(frozen=True)
class PerformerLoginState:
    status: str
    method: str | None

    def __post_init__(self) -> None:
        if self.status not in LOGIN_STATUSES:
            raise ValueError("login status is unsupported")
        if self.method is not None and self.method not in LOGIN_METHODS:
            raise ValueError("login method is unsupported")
        if self.status in {"pending", "succeeded", "failed"} and self.method is None:
            raise ValueError("active or terminal login requires a method")
        if self.status in {"idle", "lost"} and self.method is not None:
            raise ValueError("idle or lost login must not carry a method")

    def to_dict(self) -> dict[str, Any]:
        return {"status": self.status, "method": self.method}

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PerformerLoginState":
        _exact_keys(payload, {"status", "method"}, "login")
        method = payload.get("method")
        return cls(
            status=payload.get("status"),
            method=method,
        )


@dataclass(frozen=True)
class PerformerConfigurationSnapshot:
    settings: dict[str, str | None]
    source_format: str | None
    source_text: str | None

    def __post_init__(self) -> None:
        if not isinstance(self.settings, dict):
            raise ValueError("configuration settings must be an object")
        unknown = set(self.settings) - EDITABLE_SETTINGS
        if unknown:
            raise ValueError("configuration setting is unsupported")
        normalized: dict[str, str | None] = {}
        for key, value in self.settings.items():
            normalized[key] = _api_base_url(value) if value is not None else None
        object.__setattr__(self, "settings", normalized)
        if self.source_format not in {None, "text"}:
            raise ValueError("configuration source format is unsupported")
        if self.source_text is not None:
            if self.source_format is None:
                raise ValueError("configuration source text requires a format")
            _safe_text(
                self.source_text,
                "configuration source text",
                max_bytes=MAX_CONTROL_TEXT_BYTES,
                allow_newlines=True,
            )

    def to_dict(self) -> dict[str, Any]:
        return {
            "settings": dict(self.settings),
            "source_format": self.source_format,
            "source_text": self.source_text,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PerformerConfigurationSnapshot":
        _exact_keys(payload, {"settings", "source_format", "source_text"}, "configuration")
        settings = payload.get("settings")
        if not isinstance(settings, dict):
            raise ValueError("configuration settings must be an object")
        source_format = payload.get("source_format")
        source_text = payload.get("source_text")
        return cls(
            settings=dict(settings),
            source_format=source_format,
            source_text=source_text,
        )


@dataclass(frozen=True)
class PerformerCheckOutcome:
    status: str
    started_at: str
    finished_at: str
    summary: str

    def __post_init__(self) -> None:
        if self.status not in {"passed", "failed"}:
            raise ValueError("Check outcome status is unsupported")
        _safe_text(self.started_at, "started_at", max_bytes=100)
        _safe_text(self.finished_at, "finished_at", max_bytes=100)
        _safe_text(self.summary, "summary", max_bytes=500)

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "summary": self.summary,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PerformerCheckOutcome":
        _exact_keys(payload, {"status", "started_at", "finished_at", "summary"}, "Check")
        return cls(
            status=payload.get("status"),
            started_at=payload.get("started_at"),
            finished_at=payload.get("finished_at"),
            summary=payload.get("summary"),
        )


@dataclass(frozen=True)
class PerformerControlRequest:
    protocol_version: int
    request_id: str
    operation: str
    performer_kind: str
    arguments: dict[str, Any]
    secret_input: PerformerSecretInput | None

    def __post_init__(self) -> None:
        _protocol_version(self.protocol_version)
        _identifier(self.request_id, "request_id")
        if self.operation not in CONTROL_OPERATIONS:
            raise ValueError("control operation is unsupported")
        _performer_kind(self.performer_kind)
        if not isinstance(self.arguments, dict):
            raise ValueError("control arguments must be an object")
        if self.secret_input is not None and not isinstance(
            self.secret_input, PerformerSecretInput
        ):
            raise ValueError("secret input must be PerformerSecretInput or null")
        normalized = _control_arguments(self.operation, self.arguments, self.secret_input)
        object.__setattr__(self, "arguments", normalized)

    def to_dict(self) -> dict[str, Any]:
        return {
            "protocol_version": self.protocol_version,
            "request_id": self.request_id,
            "operation": self.operation,
            "performer_kind": self.performer_kind,
            "arguments": _json_copy(self.arguments),
            "secret_input": self.secret_input.to_dict() if self.secret_input else None,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PerformerControlRequest":
        _exact_keys(
            payload,
            {
                "protocol_version",
                "request_id",
                "operation",
                "performer_kind",
                "arguments",
                "secret_input",
            },
            "control request",
        )
        arguments = payload.get("arguments")
        if not isinstance(arguments, dict):
            raise ValueError("control arguments must be an object")
        secret_payload = payload.get("secret_input")
        if secret_payload is not None and not isinstance(secret_payload, dict):
            raise ValueError("secret input metadata must be an object or null")
        return cls(
            protocol_version=payload.get("protocol_version"),
            request_id=payload.get("request_id"),
            operation=payload.get("operation"),
            performer_kind=payload.get("performer_kind"),
            arguments=dict(arguments),
            secret_input=(
                PerformerSecretInput.from_dict(secret_payload)
                if isinstance(secret_payload, dict)
                else None
            ),
        )


@dataclass(frozen=True)
class PerformerControlEvent:
    protocol_version: int
    request_id: str
    operation: str
    sequence: int
    event_kind: str
    message: str
    verification_url: str | None
    user_code: str | None
    expires_at: str | None

    def __post_init__(self) -> None:
        _protocol_version(self.protocol_version)
        _identifier(self.request_id, "request_id")
        if self.operation not in CONTROL_OPERATIONS:
            raise ValueError("control operation is unsupported")
        _positive_int(self.sequence, "sequence")
        if self.event_kind not in CONTROL_EVENT_KINDS:
            raise ValueError("control event kind is unsupported")
        _safe_text(self.message, "message", max_bytes=500)
        if self.event_kind.startswith("login."):
            if self.operation != "performer.login":
                raise ValueError("login event requires login operation")
        if self.event_kind == "login.pending":
            if self.verification_url is None or self.user_code is None:
                raise ValueError("pending login event requires verification data")
            _https_url(self.verification_url, "verification_url")
            _safe_text(self.user_code, "user_code", max_bytes=100)
            if self.expires_at is not None:
                _safe_text(self.expires_at, "expires_at", max_bytes=100)
        elif any(value is not None for value in (self.verification_url, self.user_code, self.expires_at)):
            raise ValueError("verification data is allowed only for pending login")

    def to_dict(self) -> dict[str, Any]:
        return {
            "protocol_version": self.protocol_version,
            "request_id": self.request_id,
            "operation": self.operation,
            "sequence": self.sequence,
            "event_kind": self.event_kind,
            "message": self.message,
            "verification_url": self.verification_url,
            "user_code": self.user_code,
            "expires_at": self.expires_at,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PerformerControlEvent":
        _exact_keys(
            payload,
            {
                "protocol_version",
                "request_id",
                "operation",
                "sequence",
                "event_kind",
                "message",
                "verification_url",
                "user_code",
                "expires_at",
            },
            "control event",
        )
        return cls(
            protocol_version=payload.get("protocol_version"),
            request_id=payload.get("request_id"),
            operation=payload.get("operation"),
            sequence=payload.get("sequence"),
            event_kind=payload.get("event_kind"),
            message=payload.get("message"),
            verification_url=_optional_string(payload.get("verification_url")),
            user_code=_optional_string(payload.get("user_code")),
            expires_at=_optional_string(payload.get("expires_at")),
        )


@dataclass(frozen=True)
class PerformerControlResult:
    protocol_version: int
    request_id: str
    operation: str
    status: str
    capabilities: PerformerCapabilities | None
    readiness: PerformerReadinessState | None
    account: PerformerAccountState | None
    login: PerformerLoginState | None
    configuration: PerformerConfigurationSnapshot | None
    check: PerformerCheckOutcome | None
    error: PerformerControlError | None

    def __post_init__(self) -> None:
        _protocol_version(self.protocol_version)
        _identifier(self.request_id, "request_id")
        if self.operation not in CONTROL_OPERATIONS:
            raise ValueError("control operation is unsupported")
        if self.status not in CONTROL_RESULT_STATUSES:
            raise ValueError("control result status is unsupported")
        _optional_instance(self.capabilities, PerformerCapabilities, "capabilities")
        _optional_instance(self.readiness, PerformerReadinessState, "readiness")
        _optional_instance(self.account, PerformerAccountState, "account")
        _optional_instance(self.login, PerformerLoginState, "login")
        _optional_instance(
            self.configuration,
            PerformerConfigurationSnapshot,
            "configuration",
        )
        _optional_instance(self.check, PerformerCheckOutcome, "check")
        _optional_instance(self.error, PerformerControlError, "control error")
        if self.status == "failed":
            if self.error is None:
                raise ValueError("failed control result requires an error")
            if any(
                value is not None
                for value in (
                    self.capabilities,
                    self.account,
                    self.login,
                    self.configuration,
                    self.check,
                )
            ):
                raise ValueError("failed control result cannot carry success fields")
            return
        if self.error is not None:
            raise ValueError("successful control result cannot carry an error")
        _validate_success_result(self)

    def to_dict(self) -> dict[str, Any]:
        return {
            "protocol_version": self.protocol_version,
            "request_id": self.request_id,
            "operation": self.operation,
            "status": self.status,
            "capabilities": self.capabilities.to_dict() if self.capabilities else None,
            "readiness": self.readiness.to_dict() if self.readiness else None,
            "account": self.account.to_dict() if self.account else None,
            "login": self.login.to_dict() if self.login else None,
            "configuration": self.configuration.to_dict() if self.configuration else None,
            "check": self.check.to_dict() if self.check else None,
            "error": self.error.to_dict() if self.error else None,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PerformerControlResult":
        _exact_keys(
            payload,
            {
                "protocol_version",
                "request_id",
                "operation",
                "status",
                "capabilities",
                "readiness",
                "account",
                "login",
                "configuration",
                "check",
                "error",
            },
            "control result",
        )
        return cls(
            protocol_version=payload.get("protocol_version"),
            request_id=payload.get("request_id"),
            operation=payload.get("operation"),
            status=payload.get("status"),
            capabilities=_nested(payload, "capabilities", PerformerCapabilities.from_dict),
            readiness=_nested(payload, "readiness", PerformerReadinessState.from_dict),
            account=_nested(payload, "account", PerformerAccountState.from_dict),
            login=_nested(payload, "login", PerformerLoginState.from_dict),
            configuration=_nested(
                payload, "configuration", PerformerConfigurationSnapshot.from_dict
            ),
            check=_nested(payload, "check", PerformerCheckOutcome.from_dict),
            error=_nested(payload, "error", PerformerControlError.from_dict),
        )


def _control_arguments(
    operation: str,
    arguments: dict[str, Any],
    secret_input: PerformerSecretInput | None,
) -> dict[str, Any]:
    if operation in {"performer.status", "performer.config.read"}:
        _exact_keys(arguments, set(), "control arguments")
        _no_secret(secret_input)
        return {}
    if operation == "performer.login":
        _exact_keys(arguments, {"method"}, "login arguments")
        method = str(arguments.get("method") or "")
        if method not in LOGIN_METHODS:
            raise ValueError("login method is unsupported")
        if method == "api_key":
            if secret_input is None or secret_input.kind != "api_key":
                raise ValueError("API-key login requires secret input metadata")
        else:
            _no_secret(secret_input)
        return {"method": method}
    if operation == "performer.session.delete":
        _exact_keys(arguments, {"action"}, "session delete arguments")
        _no_secret(secret_input)
        action = str(arguments.get("action") or "")
        if action not in _SESSION_DELETE_ACTIONS:
            raise ValueError("session delete action is unsupported")
        return {"action": action}
    if operation == "performer.config.write":
        _exact_keys(arguments, {"setting", "value"}, "config write arguments")
        _no_secret(secret_input)
        setting = str(arguments.get("setting") or "")
        if setting not in EDITABLE_SETTINGS:
            raise ValueError("configuration setting is unsupported")
        return {"setting": setting, "value": _api_base_url(arguments.get("value"))}
    if operation == "performer.check":
        _exact_keys(
            arguments,
            {"binding_generation", "execution_policy", "execution_policy_sha256"},
            "Check arguments",
        )
        _no_secret(secret_input)
        binding_generation = _positive_int(
            arguments.get("binding_generation"), "binding_generation"
        )
        policy = RuntimePolicy.from_dict(arguments.get("execution_policy"))
        expected_hash = canonical_sha256(policy.to_dict())
        supplied_hash = str(arguments.get("execution_policy_sha256") or "")
        if supplied_hash != expected_hash:
            raise RuntimePolicyError(
                "execution_policy_hash_mismatch",
                "Supplied execution policy hash does not match content",
            )
        return {
            "binding_generation": binding_generation,
            "execution_policy": policy.to_dict(),
            "execution_policy_sha256": expected_hash,
        }
    raise ValueError("control operation is unsupported")


def _validate_success_result(result: PerformerControlResult) -> None:
    values = {
        "capabilities": result.capabilities,
        "readiness": result.readiness,
        "account": result.account,
        "login": result.login,
        "configuration": result.configuration,
        "check": result.check,
    }
    required: dict[str, set[str]] = {
        "performer.status": {"capabilities", "readiness", "account", "login"},
        "performer.login": {"readiness", "login"},
        "performer.session.delete": {"readiness", "account", "login"},
        "performer.config.read": {"configuration"},
        "performer.config.write": {"readiness", "configuration"},
        "performer.check": {"readiness", "check"},
    }
    allowed = required[result.operation] | (
        {"account"} if result.operation == "performer.login" else set()
    )
    missing = [key for key in required[result.operation] if values[key] is None]
    unexpected = [key for key, value in values.items() if value is not None and key not in allowed]
    if missing:
        raise ValueError(f"successful {result.operation} result requires {missing[0]}")
    if unexpected:
        raise ValueError(f"successful {result.operation} result rejects {unexpected[0]}")


def _nested(payload: dict[str, Any], key: str, parser: Any) -> Any:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError(f"{key} must be an object or null")
    return parser(value)


def _optional_instance(value: Any, expected_type: type[Any], label: str) -> None:
    if value is not None and not isinstance(value, expected_type):
        raise ValueError(f"{label} must be {expected_type.__name__} or null")


def _protocol_version(value: Any) -> int:
    if value != CONTROL_PROTOCOL_VERSION or isinstance(value, bool):
        raise ValueError("protocol_version must be 1")
    return CONTROL_PROTOCOL_VERSION


def _boolean(value: Any, field: str) -> None:
    if not isinstance(value, bool):
        raise ValueError(f"{field} must be a boolean")


def _performer_kind(value: str) -> str:
    if value not in PERFORMER_KINDS:
        raise ValueError("performer_kind is unsupported")
    return value


def _string_tuple(value: Any, field: str) -> tuple[str, ...]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"{field} must be a string list")
    return tuple(value)


def _closed_tuple(
    value: tuple[str, ...],
    allowed: frozenset[str],
    field: str,
    *,
    require_nonempty: bool = False,
) -> None:
    if not isinstance(value, tuple):
        raise ValueError(f"{field} must be a tuple")
    if require_nonempty and not value:
        raise ValueError(f"{field} must not be empty")
    if len(value) != len(set(value)) or any(item not in allowed for item in value):
        raise ValueError(f"{field} contains an unsupported value")


def _api_base_url(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("api_base_url must be a string")
    _safe_text(value, "api_base_url", max_bytes=2_048)
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("api_base_url must be an HTTP(S) URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("api_base_url must not contain userinfo")
    if parsed.fragment:
        raise ValueError("api_base_url must not contain a fragment")
    return value


def _https_url(value: str, field: str) -> str:
    _safe_text(value, field, max_bytes=2_048)
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError(f"{field} must be a safe HTTPS URL")
    return value


def _no_secret(value: PerformerSecretInput | None) -> None:
    if value is not None:
        raise ValueError("operation does not accept secret input")


def _optional_string(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("optional text must be a string or null")
    return value


__all__ = [
    "CONTROL_OPERATIONS",
    "CONTROL_PROTOCOL_VERSION",
    "PerformerAccountState",
    "PerformerCapabilities",
    "PerformerCheckOutcome",
    "PerformerConfigurationSnapshot",
    "PerformerControlError",
    "PerformerControlEvent",
    "PerformerControlRequest",
    "PerformerControlResult",
    "PerformerLoginState",
    "PerformerReadinessState",
    "PerformerSecretInput",
]
