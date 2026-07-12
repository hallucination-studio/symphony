"""Shared, secret-free Codex runtime configuration contract.

Podium and Conductor exchange this small envelope over the existing project
configuration command. Authentication state is deliberately not part of it.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import re
import tomllib
from typing import Any


MAX_CODEX_CONFIG_BYTES = 128 * 1024
MAX_PERFORMER_POLICY_BYTES = 32 * 1024
_SHA256 = re.compile(r"\A[0-9a-f]{64}\Z")
_IDENTIFIER = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\Z")
_ENV_REFERENCE = re.compile(r"\A\$[A-Za-z_][A-Za-z0-9_]*\Z")
_SECRET_KEY = re.compile(
    r"(?i)(?:access[-_]?token|refresh[-_]?token|api[-_]?key|client[-_]?secret|"
    r"authorization|password|cookie|secret|credential)"
)
_NON_SECRET_KEYS = frozenset({"cli_auth_credentials_store"})
_SECRET_LITERAL = re.compile(
    r"(?i)(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|"
    r"github_pat_[A-Za-z0-9_]{20,}|bearer\s+[A-Za-z0-9._~+/=-]{12,})"
)
_REASONING_EFFORTS = frozenset({"minimal", "low", "medium", "high", "xhigh"})
_APPROVAL_POLICIES = frozenset({"untrusted", "on-request", "never"})
_APPROVAL_REVIEWERS = frozenset({"user", "auto_review"})
_SANDBOX_MODES = frozenset({"read-only", "workspace-write", "danger-full-access"})
_AUTH_STORES = frozenset({"file", "keyring", "auto"})
_LOGIN_METHODS = frozenset({"chatgpt", "api"})
_TOP_LEVEL_KEYS = frozenset(
    {
        "model_provider",
        "model",
        "disable_response_storage",
        "model_reasoning_effort",
        "approval_policy",
        "approvals_reviewer",
        "sandbox_mode",
        "service_tier",
        "plan_mode_reasoning_effort",
        "cli_auth_credentials_store",
        "forced_login_method",
        "forced_chatgpt_workspace_id",
        "chatgpt_base_url",
        "openai_base_url",
        "allow_login_shell",
        "model_reasoning_summary",
        "model_verbosity",
        "model_providers",
        "sandbox_workspace_write",
    }
)
_MODEL_PROVIDER_KEYS = frozenset(
    {
        "name",
        "base_url",
        "wire_api",
        "requires_openai_auth",
        "env_key",
        "request_max_retries",
        "stream_max_retries",
    }
)
_SANDBOX_WORKSPACE_KEYS = frozenset({"network_access", "writable_roots"})
_LEGACY_PROFILE_REVISION_FIELDS = frozenset(
    {
        "runtime_config_version",
        "policy_revision",
        "runtime_profile_revision",
        "runtime_profile_revision_id",
        "performer_profile_revision",
        "performer_profile_revision_id",
    }
)


class CodexRuntimeConfigError(ValueError):
    """Raised when a Podium-managed config is not safe or valid."""

    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


@dataclass(frozen=True)
class CodexRuntimeConfig:
    binding_id: str
    binding_config_version: int
    runtime_profile_id: str
    config_format: str
    config_document: str
    config_sha256: str

    @classmethod
    def create(
        cls,
        *,
        binding_id: str,
        binding_config_version: int,
        runtime_profile_id: str,
        config_document: str,
        config_format: str = "toml",
    ) -> "CodexRuntimeConfig":
        normalized_format = _required_format(config_format)
        if normalized_format != "toml":
            raise CodexRuntimeConfigError(
                "managed_codex_config_invalid",
                "Only TOML Codex runtime profiles are supported",
            )
        normalized = validate_codex_toml(config_document)
        return cls(
            binding_id=_required_id(binding_id, "binding_id"),
            binding_config_version=_positive_int(binding_config_version, "binding_config_version"),
            runtime_profile_id=_required_id(runtime_profile_id, "runtime_profile_id"),
            config_format=normalized_format,
            config_document=normalized,
            config_sha256=_sha256(normalized),
        )

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "CodexRuntimeConfig":
        if not isinstance(payload, dict):
            raise CodexRuntimeConfigError("invalid_runtime_config", "Runtime config must be an object")
        _reject_profile_revision_fields(payload)
        config = cls.create(
            binding_id=str(payload.get("binding_id") or ""),
            binding_config_version=payload.get("binding_config_version"),
            runtime_profile_id=str(payload.get("runtime_profile_id") or ""),
            config_format=str(payload.get("config_format") or ""),
            config_document=str(payload.get("config_document") or ""),
        )
        supplied_hash = str(payload.get("config_sha256") or "")
        if supplied_hash != config.config_sha256:
            raise CodexRuntimeConfigError("runtime_config_hash_mismatch", "Runtime config hash does not match content")
        return config

    def to_dict(self) -> dict[str, Any]:
        return {
            "binding_id": self.binding_id,
            "binding_config_version": self.binding_config_version,
            "runtime_profile_id": self.runtime_profile_id,
            "config_format": self.config_format,
            "config_document": self.config_document,
            "config_sha256": self.config_sha256,
        }

    def public_summary(self) -> dict[str, Any]:
        return {
            "binding_id": self.binding_id,
            "binding_config_version": self.binding_config_version,
            "runtime_profile_id": self.runtime_profile_id,
            "config_format": self.config_format,
            "config_sha256": self.config_sha256,
        }


@dataclass(frozen=True)
class PerformerProfileConfig:
    """Secret-free current Performer/runtime selection delivered to Conductor."""

    binding_id: str
    binding_config_version: int
    performer_binding_id: str
    performer_profile_id: str
    runtime_profile_id: str
    performer_kind: str
    runtime_kind: str
    turn_policy: dict[str, Any]
    policy_sha256: str
    config_format: str
    config_document: str
    config_sha256: str
    credential_id: str
    credential_ref: str

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
        turn_policy: dict[str, Any],
        config_document: str,
        credential_id: str,
        credential_ref: str,
        config_format: str = "toml",
    ) -> "PerformerProfileConfig":
        runtime = CodexRuntimeConfig.create(
            binding_id=binding_id,
            binding_config_version=binding_config_version,
            runtime_profile_id=runtime_profile_id,
            config_format=config_format,
            config_document=config_document,
        )
        normalized_policy = _validate_turn_policy(turn_policy)
        return cls(
            binding_id=runtime.binding_id,
            binding_config_version=runtime.binding_config_version,
            performer_binding_id=_required_id(performer_binding_id, "performer_binding_id"),
            performer_profile_id=_required_id(performer_profile_id, "performer_profile_id"),
            runtime_profile_id=runtime.runtime_profile_id,
            performer_kind=_required_id(performer_kind, "performer_kind"),
            runtime_kind=_required_id(runtime_kind, "runtime_kind"),
            turn_policy=normalized_policy,
            policy_sha256=_sha256(_canonical_json(normalized_policy)),
            config_format=runtime.config_format,
            config_document=runtime.config_document,
            config_sha256=runtime.config_sha256,
            credential_id=_required_id(credential_id, "credential_id"),
            credential_ref=_credential_ref(credential_ref),
        )

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PerformerProfileConfig":
        if not isinstance(payload, dict):
            raise CodexRuntimeConfigError("invalid_performer_profile", "Performer profile config must be an object")
        _reject_profile_revision_fields(payload)
        config = cls.create(
            binding_id=str(payload.get("binding_id") or ""),
            binding_config_version=payload.get("binding_config_version"),
            performer_binding_id=str(payload.get("performer_binding_id") or ""),
            performer_profile_id=str(payload.get("performer_profile_id") or ""),
            runtime_profile_id=str(payload.get("runtime_profile_id") or ""),
            performer_kind=str(payload.get("performer_kind") or ""),
            runtime_kind=str(payload.get("runtime_kind") or ""),
            turn_policy=payload.get("turn_policy") if isinstance(payload.get("turn_policy"), dict) else {},
            config_format=str(payload.get("config_format") or ""),
            config_document=str(payload.get("config_document") or ""),
            credential_id=str(payload.get("credential_id") or ""),
            credential_ref=str(payload.get("credential_ref") or ""),
        )
        if str(payload.get("config_sha256") or "") != config.config_sha256:
            raise CodexRuntimeConfigError("runtime_config_hash_mismatch", "Runtime config hash does not match content")
        if str(payload.get("policy_sha256") or "") != config.policy_sha256:
            raise CodexRuntimeConfigError("performer_policy_hash_mismatch", "Performer policy hash does not match content")
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
            "turn_policy": dict(self.turn_policy),
            "policy_sha256": self.policy_sha256,
            "config_format": self.config_format,
            "config_document": self.config_document,
            "config_sha256": self.config_sha256,
            "credential_id": self.credential_id,
            "credential_ref": self.credential_ref,
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
            "config_sha256": self.config_sha256,
            "policy_sha256": self.policy_sha256,
            "credential_id": self.credential_id,
        }


def validate_codex_toml(value: str) -> str:
    if not isinstance(value, str):
        raise CodexRuntimeConfigError("managed_codex_config_invalid", "Codex config must be text")
    normalized = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        raise CodexRuntimeConfigError("managed_codex_config_invalid", "Codex config cannot be empty")
    normalized += "\n"
    if len(normalized.encode("utf-8")) > MAX_CODEX_CONFIG_BYTES:
        raise CodexRuntimeConfigError("managed_codex_config_too_large", "Codex config is too large")
    if "\x00" in normalized or _SECRET_LITERAL.search(normalized):
        raise CodexRuntimeConfigError("managed_codex_secret_rejected", "Codex config contains a secret value")
    try:
        parsed = tomllib.loads(normalized)
    except tomllib.TOMLDecodeError as exc:
        raise CodexRuntimeConfigError("managed_codex_config_invalid", "Codex config TOML is invalid") from exc
    _validate_document(parsed)
    return normalized


def _validate_document(document: dict[str, Any]) -> None:
    unknown = sorted(set(document) - _TOP_LEVEL_KEYS)
    if unknown:
        raise CodexRuntimeConfigError("managed_codex_config_key_rejected", f"Codex config key is not allowed: {unknown[0]}")
    for key, value in document.items():
        _validate_value(key, value)
    _enum(document, "model_reasoning_effort", _REASONING_EFFORTS)
    _enum(document, "plan_mode_reasoning_effort", _REASONING_EFFORTS)
    _enum(document, "approval_policy", _APPROVAL_POLICIES)
    _enum(document, "approvals_reviewer", _APPROVAL_REVIEWERS)
    _enum(document, "sandbox_mode", _SANDBOX_MODES)
    _enum(document, "cli_auth_credentials_store", _AUTH_STORES)
    _enum(document, "forced_login_method", _LOGIN_METHODS)
    providers = document.get("model_providers")
    if providers is not None:
        if not isinstance(providers, dict):
            raise CodexRuntimeConfigError("managed_codex_config_invalid", "model_providers must be a table")
        for name, provider in providers.items():
            if not isinstance(name, str) or not name or not isinstance(provider, dict):
                raise CodexRuntimeConfigError("managed_codex_config_invalid", "model provider table is invalid")
            unknown_provider = sorted(set(provider) - _MODEL_PROVIDER_KEYS)
            if unknown_provider:
                raise CodexRuntimeConfigError(
                    "managed_codex_config_key_rejected",
                    f"Codex model provider key is not allowed: {unknown_provider[0]}",
                )
            for key, value in provider.items():
                _validate_value(key, value)
    sandbox = document.get("sandbox_workspace_write")
    if sandbox is not None:
        if not isinstance(sandbox, dict):
            raise CodexRuntimeConfigError("managed_codex_config_invalid", "sandbox_workspace_write must be a table")
        unknown_sandbox = sorted(set(sandbox) - _SANDBOX_WORKSPACE_KEYS)
        if unknown_sandbox:
            raise CodexRuntimeConfigError(
                "managed_codex_config_key_rejected",
                f"Codex sandbox key is not allowed: {unknown_sandbox[0]}",
            )
        for key, value in sandbox.items():
            _validate_value(key, value)


def _validate_value(key: str, value: Any) -> None:
    if key not in _NON_SECRET_KEYS and _SECRET_KEY.search(key):
        if not isinstance(value, str) or _ENV_REFERENCE.fullmatch(value.strip()) is None:
            raise CodexRuntimeConfigError(
                "managed_codex_secret_rejected",
                f"Codex secret-bearing key must use $VAR indirection: {key}",
            )
    if isinstance(value, str) and len(value) > 4096:
        raise CodexRuntimeConfigError("managed_codex_config_invalid", f"Codex config value is too long: {key}")
    if isinstance(value, dict):
        for nested_key, nested_value in value.items():
            _validate_value(str(nested_key), nested_value)
    elif isinstance(value, list):
        for item in value:
            _validate_value(key, item)


def _enum(document: dict[str, Any], key: str, allowed: frozenset[str]) -> None:
    value = document.get(key)
    if value is not None and (not isinstance(value, str) or value not in allowed):
        raise CodexRuntimeConfigError("managed_codex_config_invalid", f"Codex config value is invalid: {key}")


def _required_id(value: str, field: str) -> str:
    normalized = value.strip() if isinstance(value, str) else ""
    if not _IDENTIFIER.fullmatch(normalized):
        raise CodexRuntimeConfigError("invalid_runtime_config", f"{field} is invalid")
    return normalized


def _required_format(value: str) -> str:
    normalized = value.strip().lower() if isinstance(value, str) else ""
    if normalized not in {"toml"}:
        raise CodexRuntimeConfigError("managed_codex_config_invalid", "config_format must be toml")
    return normalized


def _credential_ref(value: str) -> str:
    normalized = value.strip() if isinstance(value, str) else ""
    if not normalized or len(normalized) > 200 or "/" in normalized or "\\" in normalized:
        raise CodexRuntimeConfigError("invalid_credential_reference", "credential_ref must be an opaque local reference")
    if _SECRET_LITERAL.search(normalized) or re.search(
        r"(?i)(?:bearer|basic)\s+|(?:access[_-]?token|refresh[_-]?token|api[_-]?key)\s*[=:]",
        normalized,
    ):
        raise CodexRuntimeConfigError("invalid_credential_reference", "credential_ref must not contain a credential")
    return normalized


def _validate_turn_policy(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CodexRuntimeConfigError("invalid_performer_policy", "turn_policy must be an object")
    try:
        canonical = _canonical_json(value)
    except (TypeError, ValueError) as exc:
        raise CodexRuntimeConfigError("invalid_performer_policy", "turn_policy contains unsupported values") from exc
    if len(canonical.encode("utf-8")) > MAX_PERFORMER_POLICY_BYTES:
        raise CodexRuntimeConfigError("performer_policy_too_large", "turn_policy is too large")
    _validate_policy_values(value)
    return dict(value)


def _validate_policy_values(value: Any, key: str = "turn_policy") -> None:
    if isinstance(value, dict):
        for nested_key, nested_value in value.items():
            name = str(nested_key)
            if _SECRET_KEY.search(name):
                raise CodexRuntimeConfigError(
                    "managed_codex_secret_rejected",
                    f"Performer policy cannot contain credential-bearing key: {name}",
                )
            _validate_policy_values(nested_value, name)
    elif isinstance(value, list):
        for item in value:
            _validate_policy_values(item, key)
    elif isinstance(value, (str, int, float, bool)) or value is None:
        if isinstance(value, str) and (_SECRET_LITERAL.search(value) or len(value) > 4096):
            raise CodexRuntimeConfigError("managed_codex_secret_rejected", "Performer policy contains an unsafe value")
        return
    else:
        raise CodexRuntimeConfigError("invalid_performer_policy", "Performer policy contains an unsupported value")


def _canonical_json(value: dict[str, Any]) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _reject_profile_revision_fields(payload: dict[str, Any]) -> None:
    legacy = sorted(_LEGACY_PROFILE_REVISION_FIELDS.intersection(payload))
    if legacy:
        raise CodexRuntimeConfigError(
            "profile_revision_field_rejected",
            f"Profile revision fields are not supported: {legacy[0]}",
        )


def _positive_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise CodexRuntimeConfigError("invalid_runtime_config", f"{field} must be positive")
    return value


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


__all__ = [
    "CodexRuntimeConfig",
    "CodexRuntimeConfigError",
    "MAX_CODEX_CONFIG_BYTES",
    "MAX_PERFORMER_POLICY_BYTES",
    "PerformerProfileConfig",
    "validate_codex_toml",
]
