from __future__ import annotations

from performer_api.managed_runs_enums import RUN_SUMMARY_END, RUN_SUMMARY_START
from performer_api.managed_runs_results import ThreadCompletionReport
from performer_api.managed_runs_utils import _str_list


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
