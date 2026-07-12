from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import re
from typing import Any

from performer_api.codex_runtime import (
    CodexRuntimeConfig,
    CodexRuntimeConfigError,
    PerformerProfileConfig,
)


MAX_PROFILE_METADATA_BYTES = 64 * 1024
_IDENTIFIER = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]{0,79}\Z")
_SECRET_LITERAL = re.compile(
    r"(?i)(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|"
    r"github_pat_[A-Za-z0-9_]{20,}|bearer\s+[A-Za-z0-9._~+/=-]{12,})"
)
_AUTH_METHODS = frozenset({"chatgpt_oauth", "api_key", "provider_token"})
_PERFORMER_KEYS = frozenset({"performer_kind", "runtime_kind", "turn_policy", "credential_id"})
_CREDENTIAL_KEYS = frozenset({"id", "name", "auth_method", "account_hint", "local_ref"})


class PerformerProfileLoadError(ValueError):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


@dataclass(frozen=True)
class ProfileBundle:
    runtime_profile: dict[str, Any]
    performer_profile: dict[str, Any]
    credentials: list[dict[str, Any]]
    selected_credential: dict[str, Any]


def load_profile_bundle(
    root: Path | str,
    *,
    workspace_id: str,
    profile_name: str = "default",
) -> ProfileBundle:
    profile_dir = _profile_dir(root, profile_name)
    runtime_document = _read_text(profile_dir / "runtime.toml")
    performer_payload = _read_json_object(profile_dir / "performer.json")
    credentials_payload = _read_json_list(profile_dir / "credentials.json")
    unknown = sorted(set(performer_payload) - _PERFORMER_KEYS)
    if unknown:
        raise PerformerProfileLoadError(
            "performer_profile_key_rejected",
            f"Performer profile key is not allowed: {unknown[0]}",
        )
    if not credentials_payload:
        raise PerformerProfileLoadError("performer_credential_required", "At least one credential metadata record is required")

    workspace = _identifier(workspace_id, "workspace_id")
    profile = _identifier(profile_name, "profile_name")
    runtime_profile_id = f"runtime-profile:{workspace}:{profile}"
    performer_profile_id = f"performer-profile:{workspace}:{profile}"
    performer_kind = _identifier(performer_payload.get("performer_kind") or "codex", "performer_kind")
    runtime_kind = _identifier(performer_payload.get("runtime_kind") or "codex", "runtime_kind")
    turn_policy = performer_payload.get("turn_policy")
    if not isinstance(turn_policy, dict):
        raise PerformerProfileLoadError("invalid_performer_policy", "turn_policy must be an object")

    credentials = [_credential_record(workspace, record) for record in credentials_payload]
    credential_ids = {str(record["source_id"]) for record in credentials}
    selected_source_id = str(performer_payload.get("credential_id") or credentials[0]["source_id"])
    if selected_source_id not in credential_ids:
        raise PerformerProfileLoadError("performer_credential_not_found", "Selected Performer credential was not found")
    selected = next(record for record in credentials if record["source_id"] == selected_source_id)
    try:
        config = PerformerProfileConfig.create(
            binding_id="profile-load",
            binding_config_version=1,
            performer_binding_id="profile-load",
            performer_profile_id=performer_profile_id,
            runtime_profile_id=runtime_profile_id,
            performer_kind=performer_kind,
            runtime_kind=runtime_kind,
            turn_policy=turn_policy,
            config_document=runtime_document,
            credential_id=str(selected["id"]),
            credential_ref=str(selected["local_ref"]),
        )
    except CodexRuntimeConfigError as exc:
        raise PerformerProfileLoadError(exc.code, exc.reason) from exc

    runtime_profile = {
        "id": runtime_profile_id,
        "name": profile,
        "runtime_kind": runtime_kind,
        "config_format": config.config_format,
        "config_document": config.config_document,
        "config_sha256": config.config_sha256,
        "state": "active",
    }
    performer_profile = {
        "id": performer_profile_id,
        "name": profile,
        "performer_kind": performer_kind,
        "runtime_profile_id": runtime_profile_id,
        "turn_policy": config.turn_policy,
        "policy_sha256": config.policy_sha256,
        "state": "active",
    }
    return ProfileBundle(
        runtime_profile=runtime_profile,
        performer_profile=performer_profile,
        credentials=[_public_credential(record) for record in credentials],
        selected_credential=_public_credential(selected),
    )


def _profile_dir(root: Path | str, profile_name: str) -> Path:
    raw = str(root or "").strip()
    if not raw:
        raise PerformerProfileLoadError("performer_profile_required", "A managed Performer profile directory is required")
    base = Path(raw).expanduser().resolve()
    if not base.is_dir():
        raise PerformerProfileLoadError("performer_profile_required", "Managed Performer profile directory is unavailable")
    candidate = base / profile_name
    directory = candidate if candidate.is_dir() else base
    if not (directory / "runtime.toml").is_file() or not (directory / "performer.json").is_file() or not (directory / "credentials.json").is_file():
        raise PerformerProfileLoadError("performer_profile_required", "Managed Performer profile files are incomplete")
    return directory


def _read_text(path: Path) -> str:
    try:
        if path.stat().st_size > MAX_PROFILE_METADATA_BYTES * 2:
            raise PerformerProfileLoadError("performer_profile_too_large", "Managed Performer profile file is too large")
        return path.read_text(encoding="utf-8")
    except PerformerProfileLoadError:
        raise
    except (OSError, UnicodeError) as exc:
        raise PerformerProfileLoadError("performer_profile_required", "Managed Performer profile file is unreadable") from exc


def _read_json(path: Path) -> Any:
    content = _read_text(path)
    if len(content.encode("utf-8")) > MAX_PROFILE_METADATA_BYTES:
        raise PerformerProfileLoadError("performer_profile_too_large", "Managed Performer profile metadata is too large")
    try:
        return json.loads(content)
    except json.JSONDecodeError as exc:
        raise PerformerProfileLoadError("performer_profile_invalid", "Managed Performer profile JSON is invalid") from exc


def _read_json_object(path: Path) -> dict[str, Any]:
    value = _read_json(path)
    if not isinstance(value, dict):
        raise PerformerProfileLoadError("performer_profile_invalid", "performer.json must contain an object")
    return value


def _read_json_list(path: Path) -> list[dict[str, Any]]:
    value = _read_json(path)
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise PerformerProfileLoadError("performer_credential_invalid", "credentials.json must contain objects")
    return value


def _credential_record(workspace: str, raw: dict[str, Any]) -> dict[str, Any]:
    unknown = sorted(set(raw) - _CREDENTIAL_KEYS)
    if unknown:
        raise PerformerProfileLoadError("performer_credential_key_rejected", "Credential metadata contains an unsupported field")
    source_id = _identifier(raw.get("id"), "credential_id")
    name = _bounded_text(raw.get("name"), "credential_name")
    auth_method = str(raw.get("auth_method") or "").strip()
    if auth_method not in _AUTH_METHODS:
        raise PerformerProfileLoadError("performer_credential_invalid", "Credential auth_method is invalid")
    account_hint = _bounded_text(raw.get("account_hint"), "account_hint")
    local_ref = _opaque_reference(raw.get("local_ref"))
    if _SECRET_LITERAL.search(account_hint):
        raise PerformerProfileLoadError("performer_credential_invalid", "Credential account_hint is unsafe")
    return {
        "id": f"credential:{workspace}:{source_id}",
        "source_id": source_id,
        "name": name,
        "performer_kind": "codex",
        "auth_method": auth_method,
        "account_hint": account_hint,
        "local_ref": local_ref,
        "state": "active",
    }


def _public_credential(record: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in record.items() if key != "source_id"}


def _identifier(value: Any, field: str) -> str:
    normalized = str(value or "").strip()
    if not _IDENTIFIER.fullmatch(normalized):
        raise PerformerProfileLoadError("performer_profile_invalid", f"{field} is invalid")
    return normalized


def _bounded_text(value: Any, field: str) -> str:
    normalized = str(value or "").replace("\x00", " ").replace("\r", " ").replace("\n", " ").strip()
    if not normalized or len(normalized) > 200:
        raise PerformerProfileLoadError("performer_profile_invalid", f"{field} is invalid")
    return normalized


def _opaque_reference(value: Any) -> str:
    normalized = _bounded_text(value, "local_ref")
    if "/" in normalized or "\\" in normalized or _SECRET_LITERAL.search(normalized) or re.search(
        r"(?i)(?:bearer|basic)\s+|(?:access[_-]?token|refresh[_-]?token|api[_-]?key)\s*[=:]",
        normalized,
    ):
        raise PerformerProfileLoadError("performer_credential_invalid", "Credential local_ref must be an opaque reference")
    return normalized


__all__ = ["MAX_PROFILE_METADATA_BYTES", "PerformerProfileLoadError", "ProfileBundle", "load_profile_bundle"]
