from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, Mapping, Sequence

from performer_api.turns import TurnContext


class RuntimeExecutionError(RuntimeError):
    pass


class StaleRuntimeResult(RuntimeError):
    pass


_PERFORMER_PROCESS_ENV_KEYS = (
    "HOME",
    "CODEX_HOME",
    "PATH",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "CODEX_SDK_CODEX_BIN",
)


@dataclass(frozen=True)
class RuntimePaths:
    request: Path
    result: Path
    log: Path


class PerformerRuntime:
    def __init__(
        self,
        performer_command: Sequence[str] | None = None,
        *,
        process_env: dict[str, str] | None = None,
    ) -> None:
        self.performer_command = tuple(performer_command or _default_performer_command())
        source = os.environ if process_env is None else process_env
        self.process_env = MappingProxyType(_fixed_process_environment(source))

    def prepare_environment(self) -> dict[str, str]:
        return dict(self.process_env)

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

    def run(self, paths: RuntimePaths) -> dict[str, Any]:
        process_env = dict(self.process_env)
        command = [*self.performer_command, "--turn-request-path", str(paths.request), "--turn-result-path", str(paths.result)]
        try:
            timeout_seconds = _performer_timeout_seconds(paths.request)
            completed = subprocess.run(command, env=process_env, capture_output=True, text=True, check=False, timeout=timeout_seconds)
        except subprocess.TimeoutExpired as exc:
            stdout = _sanitize_log_stream(exc.stdout)
            stderr = _sanitize_log_stream(exc.stderr)
            paths.log.write_text(f"stdout\n{stdout}\nstderr\n{stderr}\nerror_code=performer_timeout\n", encoding="utf-8")
            raise RuntimeExecutionError("performer_timeout") from exc
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

    async def run_async(self, paths: RuntimePaths) -> dict[str, Any]:
        command = [
            *self.performer_command,
            "--turn-request-path",
            str(paths.request),
            "--turn-result-path",
            str(paths.result),
        ]
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                env=dict(self.process_env),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as exc:
            raise RuntimeExecutionError(f"performer_start_failed:{exc}") from exc
        communication = asyncio.create_task(process.communicate())
        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                asyncio.shield(communication),
                timeout=_performer_timeout_seconds(paths.request),
            )
        except asyncio.TimeoutError as exc:
            await _stop_process(process)
            stdout_bytes, stderr_bytes = await communication
            stdout = _decode_process_stream(stdout_bytes)
            stderr = _decode_process_stream(stderr_bytes)
            paths.log.write_text(
                f"stdout\n{_sanitize_log_stream(stdout)}\nstderr\n{_sanitize_log_stream(stderr)}\n"
                "error_code=performer_timeout\n",
                encoding="utf-8",
            )
            raise RuntimeExecutionError("performer_timeout") from exc
        except asyncio.CancelledError:
            await _stop_process(process)
            stdout_bytes, stderr_bytes = await communication
            paths.log.write_text(
                f"stdout\n{_sanitize_log_stream(_decode_process_stream(stdout_bytes))}\n"
                f"stderr\n{_sanitize_log_stream(_decode_process_stream(stderr_bytes))}\n"
                "error_code=performer_cancelled\n",
                encoding="utf-8",
            )
            raise
        stdout = _decode_process_stream(stdout_bytes)
        stderr = _decode_process_stream(stderr_bytes)
        paths.log.write_text(
            f"stdout\n{_sanitize_log_stream(stdout)}\nstderr\n{_sanitize_log_stream(stderr)}\n"
            f"exit_code={process.returncode}\n",
            encoding="utf-8",
        )
        if process.returncode != 0:
            reason = _process_failure_reason(stdout, stderr)
            suffix = f":{reason}" if reason else ""
            raise RuntimeExecutionError(
                f"performer_failed:exit_{process.returncode}{suffix}"
            )
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


def _fixed_process_environment(source: Mapping[str, str]) -> dict[str, str]:
    environment = {
        key: str(source[key])
        for key in _PERFORMER_PROCESS_ENV_KEYS
        if source.get(key)
    }
    if not environment.get("HOME"):
        raise ValueError("conductor_home_required")
    return environment


async def _stop_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=2.0)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()


def _decode_process_stream(value: bytes | None) -> str:
    return (value or b"").decode("utf-8", errors="replace")


def _default_performer_command() -> tuple[str, ...]:
    # A venv console script may resolve ``sys.executable`` to the host Python
    # (not the venv path) while ``sys.argv[0]`` still points at ``bin/conductor``.
    # Resolve the sibling console script before falling back to PATH.
    launcher = Path(sys.argv[0]).expanduser()
    if launcher.name in {"conductor", "conductor.exe"}:
        sibling = launcher.resolve().with_name("performer")
        if sibling.is_file() and os.access(sibling, os.X_OK):
            return (str(sibling),)
    sibling = Path(sys.executable).with_name("performer")
    if sibling.is_file() and os.access(sibling, os.X_OK):
        return (str(sibling),)
    # Never fall back to an arbitrary PATH executable.  The module invocation
    # stays within the interpreter that launched Conductor.
    return (sys.executable, "-m", "performer")


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
    text = re.sub(r"(?i)(?:^|[\s=:])(?:[A-Za-z]:)?[^\s,;]*(?:[/\\](?:\.codex|auth\.json)|(?:^|:)auth\.json)(?:[/\\][^\s,;]*)?", " [REDACTED_PATH]", text)
    text = re.sub(r"(?i)(?:^|[\s=:])auth\.json(?:[/\\][^\s,;]*)?", " [REDACTED_PATH]", text)
    text = re.sub(r"(?i)\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b", "[REDACTED]", text)
    return re.sub(
        r"(?i)\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b",
        "[REDACTED]",
        text,
    )


def _sanitize_log_stream(value: Any) -> str:
    sanitized = "\n".join(_sanitize_log_event(line) for line in str(value or "").splitlines())
    return sanitized[-262_144:]


def _performer_timeout_seconds(request_path: Path) -> float:
    raw: Any = 3_600_000
    try:
        request = json.loads(request_path.read_text(encoding="utf-8"))
        policy = request.get("execution_policy") if isinstance(request, dict) else None
        if isinstance(policy, dict):
            raw = policy.get("turn_timeout_ms", raw)
    except (OSError, json.JSONDecodeError):
        pass
    try:
        milliseconds = max(1_000, int(raw))
    except (TypeError, ValueError):
        milliseconds = 3_600_000
    return max(30.0, min(3_900.0, milliseconds / 1000.0 + 30.0))


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
