from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import re
from typing import Any


class PodiumSyncFailureMixin:
    def _record_managed_run_sync_failure(
        self,
        event: str,
        instance: Any | None,
        exc: Exception,
        *,
        action_required: str,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        reason = _sanitize_error(exc)
        finding: dict[str, Any] = {
            "event": event,
            "severity": "warning",
            "error_type": exc.__class__.__name__,
            "sanitized_reason": reason,
            "action_required": action_required,
            "retryable": True,
        }
        if instance is not None:
            finding["instance_id"] = getattr(instance, "id", "")
            finding["issue_project"] = getattr(instance, "linear_project", "")
        if extra:
            finding.update({key: value for key, value in extra.items() if value is not None})
        findings = getattr(self, "_managed_run_reconcile_findings", None)
        if findings is None:
            findings = []
            self._managed_run_reconcile_findings = findings
        findings.append(finding)
        if instance is not None:
            _append_instance_log(
                instance,
                "event="
                f"{event} severity=warning instance_id={getattr(instance, 'id', '')} "
                f"error_type={exc.__class__.__name__} sanitized_reason={reason} "
                f"action_required={action_required} retryable=true",
            )
        return finding


def _append_instance_log(instance: Any, message: str) -> None:
    log_path = getattr(instance, "log_path", None)
    if not log_path:
        return
    path = Path(str(log_path))
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"{_now()} {message}\n")
    except OSError:
        return


def _sanitize_error(exc: Exception | str) -> str:
    text = str(exc).replace("\x00", "").strip()
    if not text:
        return exc.__class__.__name__ if isinstance(exc, Exception) else "runtime_error"
    text = re.sub(r"(?i)(authorization:\s*)(bearer|basic)\s+[^\s,;]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", text)
    text = re.sub(r"(?i)\b(access_token|refresh_token|api_key|token|password|client_secret|cookie)=([^ \t,;]+)", r"\1=[REDACTED]", text)
    return text[:500]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
