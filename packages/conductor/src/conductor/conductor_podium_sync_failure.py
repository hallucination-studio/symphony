from __future__ import annotations

from typing import Any

from .conductor_pipeline import _append_instance_log, _sanitize_error


class PodiumSyncFailureMixin:
    def _record_pipeline_sync_failure(
        self,
        event: str,
        instance: Any | None,
        exc: Exception,
        *,
        action_required: str,
        extra: dict[str, Any] | None = None,
    ) -> None:
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
        findings = getattr(self, "_pipeline_reconcile_findings", None)
        if findings is None:
            findings = []
            self._pipeline_reconcile_findings = findings
        findings.append(finding)
        if instance is not None:
            _append_instance_log(
                instance,
                "event="
                f"{event} severity=warning instance_id={getattr(instance, 'id', '')} "
                f"error_type={exc.__class__.__name__} sanitized_reason={reason} "
                f"action_required={action_required} retryable=true",
            )
