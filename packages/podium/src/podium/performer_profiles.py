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
_PERFORMER_KEYS = frozenset({"performer_kind", "runtime_kind", "turn_policy"})


class PerformerProfileLoadError(ValueError):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


@dataclass(frozen=True)
class ProfileBundle:
    runtime_profile: dict[str, Any]
    performer_profile: dict[str, Any]


def load_profile_bundle(
    root: Path | str,
    *,
    workspace_id: str,
    profile_name: str = "default",
) -> ProfileBundle:
    profile_dir = _profile_dir(root, profile_name)
    runtime_document = _read_text(profile_dir / "runtime.toml")
    performer_payload = _read_json_object(profile_dir / "performer.json")
    unknown = sorted(set(performer_payload) - _PERFORMER_KEYS)
    if unknown:
        raise PerformerProfileLoadError(
            "performer_profile_key_rejected",
            f"Performer profile key is not allowed: {unknown[0]}",
        )
    workspace = _identifier(workspace_id, "workspace_id")
    profile = _identifier(profile_name, "profile_name")
    runtime_profile_id = f"runtime-profile:{workspace}:{profile}"
    performer_profile_id = f"performer-profile:{workspace}:{profile}"
    performer_kind = _identifier(performer_payload.get("performer_kind") or "codex", "performer_kind")
    runtime_kind = _identifier(performer_payload.get("runtime_kind") or "codex", "runtime_kind")
    turn_policy = performer_payload.get("turn_policy")
    if not isinstance(turn_policy, dict):
        raise PerformerProfileLoadError("invalid_performer_policy", "turn_policy must be an object")

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
    if not (directory / "runtime.toml").is_file() or not (directory / "performer.json").is_file():
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


def _identifier(value: Any, field: str) -> str:
    normalized = str(value or "").strip()
    if not _IDENTIFIER.fullmatch(normalized):
        raise PerformerProfileLoadError("performer_profile_invalid", f"{field} is invalid")
    return normalized


__all__ = ["MAX_PROFILE_METADATA_BYTES", "PerformerProfileLoadError", "ProfileBundle", "load_profile_bundle"]
