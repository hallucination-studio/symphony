from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from performer_api.managed_runs_utils import _int, _jsonable_dict, _str_list


RUN_SUMMARY_START = "<!-- symphony:run-summary:start -->"
RUN_SUMMARY_END = "<!-- symphony:run-summary:end -->"


@dataclass(frozen=True)
class ThreadCompletionReport:
    status: str
    thread_id: str
    plan_version: int
    what_this_thread_did: list[str]
    files_changed: list[dict[str, Any]]
    rubric_results: list[dict[str, Any]]
    token_usage: list[dict[str, Any]]
    residual_risks: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "thread_id": self.thread_id,
            "plan_version": self.plan_version,
            "what_this_thread_did": list(self.what_this_thread_did),
            "files_changed": [_jsonable_dict(item) for item in self.files_changed],
            "rubric_results": [_jsonable_dict(item) for item in self.rubric_results],
            "token_usage": [_jsonable_dict(item) for item in self.token_usage],
            "residual_risks": list(self.residual_risks),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ThreadCompletionReport:
        return cls(
            status=str(payload.get("status") or ""),
            thread_id=str(payload.get("thread_id") or ""),
            plan_version=_int(payload.get("plan_version"), default=0),
            what_this_thread_did=_str_list(payload.get("what_this_thread_did")),
            files_changed=[_jsonable_dict(item) for item in payload.get("files_changed") or [] if isinstance(item, dict)],
            rubric_results=[_jsonable_dict(item) for item in payload.get("rubric_results") or [] if isinstance(item, dict)],
            token_usage=[_jsonable_dict(item) for item in payload.get("token_usage") or [] if isinstance(item, dict)],
            residual_risks=_str_list(payload.get("residual_risks")),
        )


def render_run_summary_block(report: ThreadCompletionReport) -> str:
    lines = [
        RUN_SUMMARY_START,
        "## Symphony Managed Run Summary",
        "",
        f"Status: {report.status}",
        f"Thread: {report.thread_id}",
        f"Plan version: {report.plan_version}",
        "",
        "### What This Thread Did",
    ]
    lines.extend(f"- {item}" for item in report.what_this_thread_did)
    lines.extend(["", "### Files Changed"])
    if report.files_changed:
        lines.extend(["| File | Action | Work Item | Reason |", "|---|---|---|---|"])
        for item in report.files_changed:
            lines.append(
                "| `{}` | {} | {} | {} |".format(
                    item.get("path", ""),
                    item.get("action", ""),
                    item.get("work_item_id", ""),
                    item.get("reason", ""),
                )
            )
    else:
        lines.append("- None.")
    lines.extend(["", "### Verification Rubric"])
    if report.rubric_results:
        lines.extend(["| Area | Result | Evidence |", "|---|---|---|"])
        for item in report.rubric_results:
            evidence = ", ".join(_str_list(item.get("evidence")))
            lines.append(f"| {item.get('area', '')} | {item.get('status', '')} | {evidence} |")
    else:
        lines.append("- No rubric results recorded.")
    lines.extend(["", "### Token Usage"])
    if report.token_usage:
        lines.extend(["| Turn | Input | Cached Input | Output | Reasoning Output |", "|---|---:|---:|---:|---:|"])
        for usage in report.token_usage:
            lines.append(
                "| {} | {} | {} | {} | {} |".format(
                    usage.get("turn", ""),
                    usage.get("input_tokens", 0),
                    usage.get("cached_input_tokens", 0),
                    usage.get("output_tokens", 0),
                    usage.get("reasoning_output_tokens", 0),
                )
            )
    else:
        lines.append("- Unavailable.")
    lines.extend(["", "### Residual Risks"])
    lines.extend(f"- {risk}" for risk in (report.residual_risks or ["None identified."]))
    lines.append(RUN_SUMMARY_END)
    return "\n".join(lines)


def replace_managed_run_summary_block(description: str, report: ThreadCompletionReport) -> str:
    block = render_run_summary_block(report)
    start = description.find(RUN_SUMMARY_START)
    end = description.find(RUN_SUMMARY_END)
    if start >= 0 and end >= start:
        return description[:start] + block + description[end + len(RUN_SUMMARY_END):]
    separator = "\n\n" if description.strip() else ""
    return f"{description.rstrip()}{separator}{block}"


__all__ = ["ThreadCompletionReport", "render_run_summary_block", "replace_managed_run_summary_block"]
