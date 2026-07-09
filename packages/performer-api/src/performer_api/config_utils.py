from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any

CODEX_CONFIG_ALLOWED_TOP_LEVEL_KEYS = {
    "model_provider",
    "model",
    "disable_response_storage",
    "model_reasoning_effort",
    "approval_policy",
    "approvals_reviewer",
    "sandbox_mode",
    "service_tier",
    "plan_mode_reasoning_effort",
}
CODEX_CONFIG_ALLOWED_SECTION_PREFIXES = (
    "model_providers",
    "sandbox_workspace_write",
)


class ConfigError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def sanitize_codex_config_template(text: str) -> str:
    lines = text.splitlines()
    output: list[str] = []
    keep_section = True
    current_section: str | None = None
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            current_section = stripped.strip("[]")
            keep_section = any(
                current_section == prefix or current_section.startswith(f"{prefix}.")
                for prefix in CODEX_CONFIG_ALLOWED_SECTION_PREFIXES
            )
            if keep_section:
                _append_line(output, line)
            continue
        if current_section is None:
            _append_allowed_top_level_line(output, line, stripped)
        elif keep_section:
            _append_line(output, line)
    while output and not output[-1].strip():
        output.pop()
    return "\n".join(output) + ("\n" if output else "")


def _append_allowed_top_level_line(output: list[str], line: str, stripped: str) -> None:
    if not stripped or stripped.startswith("#"):
        _append_line(output, line)
        return
    key = stripped.split("=", 1)[0].strip() if "=" in stripped else ""
    if key in CODEX_CONFIG_ALLOWED_TOP_LEVEL_KEYS:
        _append_line(output, line)


def _append_line(output: list[str], line: str) -> None:
    if not line.strip() and (not output or not output[-1].strip()):
        return
    output.append(line)


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


def _resolve_path(value: str | None, base_path: Path) -> Path:
    raw = _resolve_env(value) if value is not None else None
    if not raw:
        raw = str(Path(tempfile.gettempdir()) / "performer_workspaces")
    expanded = Path(os.path.expanduser(raw))
    if not expanded.is_absolute():
        expanded = base_path.parent / expanded
    return expanded.resolve()


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
