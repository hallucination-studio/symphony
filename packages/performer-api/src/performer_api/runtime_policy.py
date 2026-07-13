"""Shared, secret-free Symphony runtime policy contracts."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import re
from typing import Any


MAX_POLICY_BYTES = 32 * 1024
MAX_MODEL_ID_LENGTH = 200
MAX_POLICY_DEPTH = 32
MAX_POLICY_NODES = 1024
_IDENTIFIER = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\Z")
_SECRET_LITERAL = re.compile(
    r"(?i)(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|"
    r"github_pat_[A-Za-z0-9_]{20,}|bearer\s+[A-Za-z0-9._~+/=-]{12,}|"
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----)"
)
_JWT_LITERAL = re.compile(
    r"\A[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096}\Z"
)
_URL_USERINFO = re.compile(r"(?i)\b[a-z][a-z0-9+.-]*://[^/\s:@]+:[^@\s/]+@")
_RUNTIME_POLICY_KEYS = frozenset(
    {
        "version",
        "model",
        "model_provider",
        "approval_mode",
        "reasoning_effort",
        "reasoning_summary",
        "sandbox",
        "initialize_timeout_ms",
        "turn_timeout_ms",
        "initialize_max_attempts",
        "overload_max_attempts",
    }
)
_PROVIDER_OWNED_LEGACY_FIELDS = frozenset(
    {
        "config_format",
        "config_document",
        "config_sha256",
        "credential_id",
        "credential_ref",
        "slot_id",
        "api_host",
        "codex_home",
        "codex_endpoint",
    }
)
_PROFILE_REVISION_FIELDS = frozenset(
    {
        "runtime_config_version",
        "policy_revision",
        "runtime_profile_revision",
        "runtime_profile_revision_id",
        "performer_profile_revision",
        "performer_profile_revision_id",
    }
)
_PROFILE_KEYS = frozenset(
    {
        "binding_id",
        "binding_config_version",
        "performer_binding_id",
        "performer_profile_id",
        "runtime_profile_id",
        "performer_kind",
        "runtime_kind",
        "execution_policy",
        "execution_policy_sha256",
        "turn_policy",
        "turn_policy_sha256",
    }
)
_SECRET_KEY_NAMES = frozenset(
    {
        "token",
        "access_token",
        "refresh_token",
        "api_token",
        "auth_token",
        "api_key",
        "client_secret",
        "authorization",
        "password",
        "cookie",
        "secret",
        "credential",
        "credentials",
        "private_key",
    }
)
_APPROVAL_MODES = frozenset({"deny_all", "auto_review"})
_REASONING_EFFORTS = frozenset({"none", "minimal", "low", "medium", "high", "xhigh"})
_REASONING_SUMMARIES = frozenset({"none", "auto", "concise", "detailed"})
_SANDBOX = {
    "plan": "read_only",
    "execute": "workspace_write",
    "gate": "read_only",
}


class RuntimePolicyError(ValueError):
    """Raised when a Symphony runtime or Performer policy is invalid."""

    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


@dataclass(frozen=True)
class RuntimePolicy:
    """Closed Symphony-owned policy for one managed Performer backend."""

    version: int
    model: str
    model_provider: str
    approval_mode: str
    reasoning_effort: str
    reasoning_summary: str
    sandbox: dict[str, str]
    initialize_timeout_ms: int
    turn_timeout_ms: int
    initialize_max_attempts: int
    overload_max_attempts: int

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "RuntimePolicy":
        if not isinstance(payload, dict):
            raise RuntimePolicyError("invalid_runtime_policy", "Runtime policy must be an object")
        _reject_provider_owned_legacy_fields(payload)
        unknown = sorted(set(payload) - _RUNTIME_POLICY_KEYS)
        if unknown:
            raise RuntimePolicyError(
                "runtime_policy_key_rejected",
                "Runtime policy contains an unsupported field",
            )
        missing = sorted(_RUNTIME_POLICY_KEYS - set(payload))
        if missing:
            raise RuntimePolicyError(
                "invalid_runtime_policy",
                f"Runtime policy field is required: {missing[0]}",
            )
        if payload["version"] != 1 or isinstance(payload["version"], bool):
            raise RuntimePolicyError("invalid_runtime_policy", "version must be 1")
        model = _bounded_string(payload["model"], "model")
        model_provider = _bounded_string(payload["model_provider"], "model_provider")
        approval_mode = _enum(payload["approval_mode"], "approval_mode", _APPROVAL_MODES)
        reasoning_effort = _enum(
            payload["reasoning_effort"], "reasoning_effort", _REASONING_EFFORTS
        )
        reasoning_summary = _enum(
            payload["reasoning_summary"], "reasoning_summary", _REASONING_SUMMARIES
        )
        if payload["sandbox"] != _SANDBOX:
            raise RuntimePolicyError(
                "invalid_runtime_policy",
                "sandbox must set plan=read_only, execute=workspace_write, and gate=read_only",
            )
        policy = cls(
            version=1,
            model=model,
            model_provider=model_provider,
            approval_mode=approval_mode,
            reasoning_effort=reasoning_effort,
            reasoning_summary=reasoning_summary,
            sandbox=dict(_SANDBOX),
            initialize_timeout_ms=_positive_int(
                payload["initialize_timeout_ms"], "initialize_timeout_ms"
            ),
            turn_timeout_ms=_positive_int(payload["turn_timeout_ms"], "turn_timeout_ms"),
            initialize_max_attempts=_positive_int(
                payload["initialize_max_attempts"], "initialize_max_attempts"
            ),
            overload_max_attempts=_positive_int(
                payload["overload_max_attempts"], "overload_max_attempts"
            ),
        )
        if len(_canonical_json(policy.to_dict()).encode("utf-8")) > MAX_POLICY_BYTES:
            raise RuntimePolicyError("runtime_policy_too_large", "Runtime policy is too large")
        return policy

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "model": self.model,
            "model_provider": self.model_provider,
            "approval_mode": self.approval_mode,
            "reasoning_effort": self.reasoning_effort,
            "reasoning_summary": self.reasoning_summary,
            "sandbox": dict(self.sandbox),
            "initialize_timeout_ms": self.initialize_timeout_ms,
            "turn_timeout_ms": self.turn_timeout_ms,
            "initialize_max_attempts": self.initialize_max_attempts,
            "overload_max_attempts": self.overload_max_attempts,
        }


@dataclass(frozen=True)
class PerformerProfileConfig:
    """Current secret-free Performer/runtime selection delivered to Conductor."""

    binding_id: str
    binding_config_version: int
    performer_binding_id: str
    performer_profile_id: str
    runtime_profile_id: str
    performer_kind: str
    runtime_kind: str
    execution_policy: dict[str, Any]
    execution_policy_sha256: str
    turn_policy: dict[str, Any]
    turn_policy_sha256: str

    @classmethod
    def create(
        cls,
        *,
        binding_id: str,
        binding_config_version: int,
        performer_binding_id: str,
        performer_profile_id: str,
        runtime_profile_id: str,
        performer_kind: str,
        runtime_kind: str,
        execution_policy: dict[str, Any],
        turn_policy: dict[str, Any],
    ) -> "PerformerProfileConfig":
        runtime_policy = RuntimePolicy.from_dict(execution_policy)
        normalized_execution_policy = runtime_policy.to_dict()
        normalized_turn_policy = _validate_turn_policy(turn_policy)
        return cls(
            binding_id=_required_id(binding_id, "binding_id"),
            binding_config_version=_positive_int(
                binding_config_version, "binding_config_version"
            ),
            performer_binding_id=_required_id(performer_binding_id, "performer_binding_id"),
            performer_profile_id=_required_id(performer_profile_id, "performer_profile_id"),
            runtime_profile_id=_required_id(runtime_profile_id, "runtime_profile_id"),
            performer_kind=_required_id(performer_kind, "performer_kind"),
            runtime_kind=_required_id(runtime_kind, "runtime_kind"),
            execution_policy=normalized_execution_policy,
            execution_policy_sha256=canonical_sha256(normalized_execution_policy),
            turn_policy=normalized_turn_policy,
            turn_policy_sha256=canonical_sha256(normalized_turn_policy),
        )

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PerformerProfileConfig":
        if not isinstance(payload, dict):
            raise RuntimePolicyError(
                "invalid_performer_profile", "Performer profile config must be an object"
            )
        _reject_profile_revision_fields(payload)
        _reject_provider_owned_legacy_fields(payload)
        if set(payload) - _PROFILE_KEYS:
            raise RuntimePolicyError(
                "performer_profile_key_rejected",
                "Performer profile contains an unsupported field",
            )
        config = cls.create(
            binding_id=payload.get("binding_id"),
            binding_config_version=payload.get("binding_config_version"),
            performer_binding_id=payload.get("performer_binding_id"),
            performer_profile_id=payload.get("performer_profile_id"),
            runtime_profile_id=payload.get("runtime_profile_id"),
            performer_kind=payload.get("performer_kind"),
            runtime_kind=payload.get("runtime_kind"),
            execution_policy=payload.get("execution_policy"),
            turn_policy=payload.get("turn_policy"),
        )
        if payload.get("execution_policy_sha256") != config.execution_policy_sha256:
            raise RuntimePolicyError(
                "execution_policy_hash_mismatch",
                "Supplied execution policy hash does not match content",
            )
        if payload.get("turn_policy_sha256") != config.turn_policy_sha256:
            raise RuntimePolicyError(
                "turn_policy_hash_mismatch", "Supplied turn policy hash does not match content"
            )
        return config

    def to_dict(self) -> dict[str, Any]:
        return {
            "binding_id": self.binding_id,
            "binding_config_version": self.binding_config_version,
            "performer_binding_id": self.performer_binding_id,
            "performer_profile_id": self.performer_profile_id,
            "runtime_profile_id": self.runtime_profile_id,
            "performer_kind": self.performer_kind,
            "runtime_kind": self.runtime_kind,
            "execution_policy": _json_copy(self.execution_policy),
            "execution_policy_sha256": self.execution_policy_sha256,
            "turn_policy": _json_copy(self.turn_policy),
            "turn_policy_sha256": self.turn_policy_sha256,
        }

    def public_summary(self) -> dict[str, Any]:
        return {
            "binding_id": self.binding_id,
            "binding_config_version": self.binding_config_version,
            "performer_binding_id": self.performer_binding_id,
            "performer_profile_id": self.performer_profile_id,
            "runtime_profile_id": self.runtime_profile_id,
            "performer_kind": self.performer_kind,
            "runtime_kind": self.runtime_kind,
            "execution_policy_sha256": self.execution_policy_sha256,
            "turn_policy_sha256": self.turn_policy_sha256,
        }


def _bounded_string(value: Any, field: str) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > MAX_MODEL_ID_LENGTH
        or _contains_secret_literal(value)
    ):
        raise RuntimePolicyError(
            "invalid_runtime_policy", f"{field} must be a non-empty bounded string"
        )
    return value


def _enum(value: Any, field: str, allowed: frozenset[str]) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise RuntimePolicyError("invalid_runtime_policy", f"{field} is invalid")
    return value


def _positive_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise RuntimePolicyError("invalid_runtime_policy", f"{field} must be positive")
    return value


def _required_id(value: Any, field: str) -> str:
    normalized = value.strip() if isinstance(value, str) else ""
    if not _IDENTIFIER.fullmatch(normalized):
        raise RuntimePolicyError("invalid_performer_profile", f"{field} is invalid")
    return normalized


def _validate_turn_policy(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimePolicyError("invalid_performer_policy", "turn_policy must be an object")
    _validate_policy_values(value)
    try:
        canonical = _canonical_json(value)
        normalized = json.loads(canonical)
    except (TypeError, ValueError, RecursionError) as exc:
        raise RuntimePolicyError(
            "invalid_performer_policy", "turn_policy contains unsupported values"
        ) from exc
    if len(canonical.encode("utf-8")) > MAX_POLICY_BYTES:
        raise RuntimePolicyError("performer_policy_too_large", "turn_policy is too large")
    return normalized


def _validate_policy_values(
    value: Any,
    key: str = "turn_policy",
    *,
    depth: int = 0,
    counter: list[int] | None = None,
) -> None:
    if counter is None:
        counter = [0]
    counter[0] += 1
    if depth > MAX_POLICY_DEPTH or counter[0] > MAX_POLICY_NODES:
        raise RuntimePolicyError(
            "invalid_performer_policy", "turn_policy is too deeply nested or complex"
        )
    if isinstance(value, dict):
        for nested_key, nested_value in value.items():
            if not isinstance(nested_key, str):
                raise RuntimePolicyError(
                    "invalid_performer_policy", "turn_policy keys must be strings"
                )
            if _is_secret_key(nested_key) or nested_key in _PROVIDER_OWNED_LEGACY_FIELDS:
                raise RuntimePolicyError(
                    "runtime_policy_field_rejected",
                    "turn_policy cannot contain provider-owned or secret fields",
                )
            _validate_policy_values(
                nested_value,
                nested_key,
                depth=depth + 1,
                counter=counter,
            )
    elif isinstance(value, list):
        for item in value:
            _validate_policy_values(item, key, depth=depth + 1, counter=counter)
    elif isinstance(value, str):
        if _contains_secret_literal(value):
            raise RuntimePolicyError(
                "invalid_performer_policy", "turn_policy contains an unsafe value"
            )
    elif not isinstance(value, (int, float, bool)) and value is not None:
        raise RuntimePolicyError(
            "invalid_performer_policy", "turn_policy contains an unsupported value"
        )


def _is_secret_key(value: str) -> bool:
    segmented = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", value)
    normalized = re.sub(r"[^a-z0-9]+", "_", segmented.lower()).strip("_")
    parts = normalized.split("_") if normalized else []
    if normalized.endswith(("_count", "_limit", "_budget")) or normalized in {
        "max_tokens",
        "input_tokens",
        "output_tokens",
    }:
        return False
    secret_parts = {"token", "password", "secret", "credential", "credentials", "authorization"}
    pairs = set(zip(parts, parts[1:]))
    return bool(
        _contains_secret_literal(value)
        or normalized in _SECRET_KEY_NAMES
        or normalized.startswith("x_auth_")
        or normalized.endswith(("_api_key", "_private_key", "_credential_ref"))
        or secret_parts.intersection(parts)
        or ("api", "key") in pairs
        or ("private", "key") in pairs
    )


def _contains_secret_literal(value: str) -> bool:
    return bool(
        _SECRET_LITERAL.search(value)
        or _JWT_LITERAL.fullmatch(value)
        or _URL_USERINFO.search(value)
    )


def _reject_provider_owned_legacy_fields(payload: dict[str, Any]) -> None:
    rejected = sorted(_PROVIDER_OWNED_LEGACY_FIELDS.intersection(payload))
    if rejected:
        raise RuntimePolicyError(
            "runtime_policy_field_rejected",
            f"Provider-owned field is not supported: {rejected[0]}",
        )


def _reject_profile_revision_fields(payload: dict[str, Any]) -> None:
    legacy = sorted(_PROFILE_REVISION_FIELDS.intersection(payload))
    if legacy:
        raise RuntimePolicyError(
            "profile_revision_field_rejected",
            f"Profile revision fields are not supported: {legacy[0]}",
        )


def _canonical_json(value: dict[str, Any]) -> str:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    )


def canonical_sha256(value: dict[str, Any]) -> str:
    """Return the SHA-256 digest of one canonical JSON object."""

    if not isinstance(value, dict):
        raise RuntimePolicyError(
            "invalid_canonical_json",
            "Canonical hash input must be an object",
        )
    try:
        return _sha256(_canonical_json(value))
    except (TypeError, ValueError, RecursionError) as exc:
        raise RuntimePolicyError(
            "invalid_canonical_json",
            "Canonical hash input contains unsupported values",
        ) from exc


def _json_copy(value: dict[str, Any]) -> dict[str, Any]:
    return json.loads(_canonical_json(value))


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


__all__ = [
    "MAX_POLICY_BYTES",
    "PerformerProfileConfig",
    "RuntimePolicy",
    "RuntimePolicyError",
    "canonical_sha256",
]
