from __future__ import annotations


_CODEX_CONFIG_ALLOWED_TOP_LEVEL_KEYS = {
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
_CODEX_CONFIG_ALLOWED_SECTION_PREFIXES = (
    "model_providers",
    "sandbox_workspace_write",
)


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
                for prefix in _CODEX_CONFIG_ALLOWED_SECTION_PREFIXES
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
    if key in _CODEX_CONFIG_ALLOWED_TOP_LEVEL_KEYS:
        _append_line(output, line)


def _append_line(output: list[str], line: str) -> None:
    if not line.strip() and (not output or not output[-1].strip()):
        return
    output.append(line)
