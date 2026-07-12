from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from performer_api.codex_runtime import CodexRuntimeConfigError, validate_codex_toml
from performer_api.turns import TurnContext


class RuntimeExecutionError(RuntimeError):
    pass


class StaleRuntimeResult(RuntimeError):
    pass


_CODEX_ENV_KEYS = (
    "CODEX_MODEL",
    "CODEX_SDK_CODEX_BIN",
    "CODEX_SANDBOX",
    "CODEX_CONFIG_OVERRIDES",
    "CODEX_HARD_TURN_TIMEOUT_MS",
    "CODEX_READ_TIMEOUT_MS",
    "CODEX_INIT_MAX_ATTEMPTS",
    "CODEX_INIT_BACKOFF_MS",
    "CODEX_INIT_BACKOFF_MAX_MS",
    "CODEX_OVERLOAD_MAX_ATTEMPTS",
    "CODEX_OVERLOAD_INITIAL_DELAY_MS",
    "CODEX_OVERLOAD_MAX_DELAY_MS",
)
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


@dataclass(frozen=True)
class RuntimePaths:
    request: Path
    result: Path
    log: Path


class PerformerRuntime:
    ALLOWED_CODEX_SEED_FILES = ("config.toml", "auth.json", "version.json", "models_cache.json")

    def __init__(self, performer_command: Sequence[str] = ("performer",)) -> None:
        self.performer_command = tuple(performer_command)

    def prepare_environment(
        self,
        instance_state_root: Path,
        *,
        workspace_path: Path | str | None = None,
        home_scope: str | None = None,
        codex_config_document: str | None = None,
        credential_id: str | None = None,
        credential_ref: str | None = None,
    ) -> dict[str, str]:
        codex_home = instance_state_root / "runtime-homes" / _safe_scope(home_scope or "attempt") / "codex"
        try:
            codex_home.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ValueError(f"isolated CODEX_HOME could not be materialized: {codex_home}") from exc
        if not codex_home.is_dir():
            raise ValueError(f"isolated CODEX_HOME could not be materialized: {codex_home}")

        managed_profile = codex_config_document is not None or credential_id is not None
        if managed_profile:
            if not credential_id or not credential_ref or "/" in credential_ref or "\\" in credential_ref:
                raise ValueError("managed_codex_credential_slot_required")
            credential_slot = instance_state_root / "performer-credentials" / _safe_scope(credential_id) / "CODEX_HOME"
            if not credential_slot.is_dir():
                raise ValueError("managed_codex_credential_slot_required")
            self._copy_codex_home_seed(credential_slot, codex_home)
            if codex_config_document is None:
                raise ValueError("managed_codex_config_required")
            try:
                normalized_config = validate_codex_toml(codex_config_document)
            except CodexRuntimeConfigError as exc:
                raise ValueError(exc.code) from exc
            (codex_home / "config.toml").write_text(normalized_config, encoding="utf-8")
        else:
            source = _codex_seed_from_environment()
            if source is not None:
                self._copy_codex_home_seed(source, codex_home)
        if workspace_path is not None:
            _trust_codex_project(codex_home / "config.toml", Path(workspace_path))

        environment = {"CODEX_HOME": str(codex_home)}
        for key in _CODEX_ENV_KEYS:
            value = os.environ.get(key)
            if value:
                environment[key] = value
        return environment

    def _copy_codex_home_seed(self, source: Path, destination: Path, *, include_config: bool = True) -> None:
        for name in self.ALLOWED_CODEX_SEED_FILES:
            if name == "config.toml" and not include_config:
                continue
            source_path = source / name
            if not source_path.is_file():
                continue
            destination_path = destination / name
            if name == "config.toml":
                destination_path.write_text(
                    _sanitize_codex_config_template(source_path.read_text(encoding="utf-8")),
                    encoding="utf-8",
                )
            else:
                shutil.copy2(source_path, destination_path)

    def append_event(self, log_path: Path, message: str) -> None:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(f"{_sanitize_log_event(message)}\n")

    def read_log(
        self,
        log_path: Path,
        *,
        tail: int | None = 200,
        limit_bytes: int = 1_048_576,
        previous: bool = False,
        order: str = "desc",
    ) -> dict[str, Any]:
        normalized_order = "asc" if order == "asc" else "desc"
        if previous or not log_path.exists():
            return _empty_log(log_path, normalized_order)
        try:
            size = log_path.stat().st_size
            maximum = min(size, max(int(limit_bytes), 0))
            with log_path.open("rb") as handle:
                handle.seek(size - maximum)
                raw = handle.read(maximum)
        except OSError:
            return {**_empty_log(log_path, normalized_order), "warnings": ["log_read_failed"]}
        if size > maximum and raw:
            newline = raw.find(b"\n")
            raw = raw[newline + 1 :] if newline >= 0 else b""
        lines = [_sanitize_log_event(line) for line in raw.decode("utf-8", errors="replace").splitlines()]
        if tail is not None and tail > 0:
            lines = lines[-tail:]
        if normalized_order == "desc":
            lines.reverse()
        return {
            "generation": None,
            "path": str(log_path),
            "order": normalized_order,
            "lines": lines,
            "logs": "\n".join(lines) + ("\n" if lines else ""),
            "offset_start": size - len(raw),
            "offset_end": size,
            "warnings": [],
        }

    def paths(self, run_root: Path) -> RuntimePaths:
        run_root.mkdir(parents=True, exist_ok=True)
        return RuntimePaths(run_root / "turn-request.json", run_root / "turn-result.json", run_root / "performer.log")

    def write_request(self, paths: RuntimePaths, payload: dict[str, Any]) -> None:
        paths.request.write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")), encoding="utf-8")

    def run(self, paths: RuntimePaths, *, codex_home: Path, env: dict[str, str] | None = None) -> dict[str, Any]:
        process_env = {**os.environ, **(env or {}), "CODEX_HOME": str(codex_home)}
        command = [*self.performer_command, "--turn-request-path", str(paths.request), "--turn-result-path", str(paths.result)]
        try:
            completed = subprocess.run(command, env=process_env, capture_output=True, text=True, check=False)
        except OSError as exc:
            raise RuntimeExecutionError(f"performer_start_failed:{exc}") from exc
        paths.log.write_text(
            f"stdout\n{_sanitize_log_stream(completed.stdout)}\nstderr\n{_sanitize_log_stream(completed.stderr)}\nexit_code={completed.returncode}\n",
            encoding="utf-8",
        )
        if completed.returncode != 0:
            reason = _process_failure_reason(completed.stdout, completed.stderr)
            suffix = f":{reason}" if reason else ""
            raise RuntimeExecutionError(f"performer_failed:exit_{completed.returncode}{suffix}")
        try:
            payload = json.loads(paths.result.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeExecutionError("performer_result_invalid") from exc
        if not isinstance(payload, dict):
            raise RuntimeExecutionError("performer_result_invalid")
        return payload

    @staticmethod
    def accept_result(expected: TurnContext, payload: dict[str, Any]) -> dict[str, Any]:
        actual_payload = payload.get("context") if isinstance(payload.get("context"), dict) else {}
        actual = TurnContext.from_dict(actual_payload)
        mismatch = expected.mismatch_reason(actual)
        if mismatch is not None:
            raise StaleRuntimeResult(mismatch)
        return payload


def _codex_seed_from_environment() -> Path | None:
    raw = (os.environ.get("SYMPHONY_E2E_CODEX_HOME_SEED") or os.environ.get("CODEX_HOME_SOURCE") or "").strip()
    if not raw:
        return None
    if raw.startswith("$"):
        raw = os.environ.get(raw[1:], "").strip()
    if not raw:
        return None
    source = Path(raw).expanduser().resolve()
    if source.name == ".codex":
        raise ValueError("Codex seed must be a fixed copied directory, not ~/.codex")
    if not source.is_dir():
        raise ValueError(f"Codex seed is not a directory: {source}")
    return source


def _trust_codex_project(config_path: Path, workspace_path: Path) -> None:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    workspace = str(workspace_path.expanduser().resolve())
    header = f"[projects.{json.dumps(workspace)}]"
    existing = config_path.read_text(encoding="utf-8") if config_path.exists() else ""
    if header in existing:
        return
    suffix = "" if not existing or existing.endswith("\n") else "\n"
    config_path.write_text(f"{existing}{suffix}\n{header}\ntrust_level = \"trusted\"\n", encoding="utf-8")


def _safe_scope(value: Any) -> str:
    return "".join(char if char.isalnum() or char in {"-", "_"} else "_" for char in str(value))[:160] or "attempt"


def _sanitize_codex_config_template(text: str) -> str:
    output: list[str] = []
    keep_section = True
    current_section: str | None = None
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            current_section = stripped.strip("[]")
            keep_section = any(
                current_section == prefix or current_section.startswith(f"{prefix}.")
                for prefix in _CODEX_CONFIG_ALLOWED_SECTION_PREFIXES
            )
            if keep_section:
                _append_config_line(output, line)
        elif current_section is None:
            _append_allowed_top_level_config_line(output, line, stripped)
        elif keep_section:
            _append_config_line(output, line)
    while output and not output[-1].strip():
        output.pop()
    return "\n".join(output) + ("\n" if output else "")


def _append_allowed_top_level_config_line(output: list[str], line: str, stripped: str) -> None:
    if not stripped or stripped.startswith("#"):
        _append_config_line(output, line)
        return
    key = stripped.split("=", 1)[0].strip() if "=" in stripped else ""
    if key in _CODEX_CONFIG_ALLOWED_TOP_LEVEL_KEYS:
        _append_config_line(output, line)


def _append_config_line(output: list[str], line: str) -> None:
    if not line.strip() and (not output or not output[-1].strip()):
        return
    output.append(line)


def _empty_log(log_path: Path, order: str) -> dict[str, Any]:
    return {
        "generation": None,
        "path": str(log_path) if log_path.exists() else None,
        "order": order,
        "lines": [],
        "logs": "",
        "offset_start": 0,
        "offset_end": 0,
        "warnings": [],
    }


def _sanitize_log_event(value: str) -> str:
    text = str(value).replace("\x00", " ").replace("\r", " ").replace("\n", " ").strip()
    if not text:
        return ""
    text = re.sub(r"(?i)(authorization:\s*)(bearer|basic)\s+[^\s,;]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", text)
    text = re.sub(
        r"(?i)\b(access_token|refresh_token|api_key|token|password|client_secret|cookie)\s*[:=]\s*[^\s,;]+",
        lambda match: f"{match.group(1)}=[REDACTED]",
        text,
    )
    return re.sub(
        r"(?i)\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b",
        "[REDACTED]",
        text,
    )


def _sanitize_log_stream(value: Any) -> str:
    return "\n".join(_sanitize_log_event(line) for line in str(value or "").splitlines())


def _process_failure_reason(stdout: Any, stderr: Any) -> str:
    """Preserve one sanitized actionable process error for durable state."""

    for stream in (stdout, stderr):
        for line in _sanitize_log_stream(stream).splitlines():
            message = line.strip()
            if not message:
                continue
            if message.lower().startswith("performer startup failed:"):
                message = message.split(":", 1)[1].strip()
            return message[:500]
    return ""


__all__ = ["PerformerRuntime", "RuntimeExecutionError", "RuntimePaths", "StaleRuntimeResult"]
