from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

from linear_tree_audit import audit_tree, fetch_issue_tree
from runtime_claims_audit import (
    attempt_artifacts,
    audit_runtime_evidence,
    generation_log_paths,
    sanitize_evidence_value,
    sanitize_text,
)


def tail_text(path: Path, max_bytes: int = 80_000) -> str:
    if not path.is_file():
        return ""
    with path.open("rb") as handle:
        handle.seek(0, 2)
        size = handle.tell()
        handle.seek(max(0, size - max_bytes))
        data = handle.read(max_bytes)
    return sanitize_text(data.decode("utf-8", errors="replace"))


def runtime_log_tail(instance_root: Path) -> tuple[list[str], list[str]]:
    generations = generation_log_paths(instance_root)
    attempts = attempt_artifacts(instance_root)
    sources = [*generations, *[entry.log for entry in attempts if entry.log is not None]]
    lines: list[str] = []
    for source in sources[-4:]:
        lines.extend(tail_text(source, max_bytes=20_000).splitlines())
    return [source.relative_to(instance_root).as_posix() for source in sources], lines[-80:]


async def sample(issue: str, instance_root: Path) -> dict[str, Any]:
    instance_root = instance_root.resolve()
    data_root = instance_root.parent.parent
    instance_id = instance_root.name
    tree_result: dict[str, Any] | None = None
    tree_error: str | None = None
    try:
        tree_result = audit_tree(await fetch_issue_tree(issue))
    except Exception as exc:
        tree_error = sanitize_text(str(exc))
    runtime_result = audit_runtime_evidence(data_root, instance_id=instance_id)
    log_sources, log_tail = runtime_log_tail(instance_root)
    findings = diagnose(tree_result, runtime_result)
    if tree_error:
        findings.append("linear_tree:fetch_failed")
    pending: list[str] = []
    if not _linear_tree_terminal(tree_result):
        pending = [finding for finding in findings if _pending_runtime_evidence(finding, runtime_result)]
        findings = [finding for finding in findings if finding not in pending]
    result = {
        "sampled_at_unix": time.time(),
        "issue": issue,
        "instance_id": instance_id,
        "linear_tree": tree_result,
        "linear_tree_error": tree_error,
        "runtime": runtime_result,
        "log_sources": log_sources,
        "log_tail": log_tail,
        "diagnosis": findings,
        "pending_diagnosis": pending,
    }
    return sanitize_evidence_value(result)


def diagnose(tree: dict[str, Any] | None, runtime: dict[str, Any]) -> list[str]:
    findings: list[str] = []
    findings.extend(f"runtime:{failure}" for failure in runtime.get("failures", []))
    if not tree:
        return findings
    business = tree.get("business_issue") or {}
    labels = set(business.get("labels") or [])
    if "performer:type/task" in labels and business.get("managed_run_metadata_present") is not True:
        findings.append("linear_tree:missing_pipeline_metadata")
    findings.extend(f"linear_tree:{failure}" for failure in tree.get("failures", []))
    return findings


async def observe(args: argparse.Namespace) -> dict[str, Any]:
    samples: list[dict[str, Any]] = []
    started_at = time.monotonic()
    deadline = started_at + max(0.0, float(args.timeout))
    pending_grace = max(0.0, float(getattr(args, "pending_grace", 60.0)))
    last_progress_at = started_at
    last_progress: tuple[Any, ...] | None = None
    termination_reason = "timeout"
    while True:
        row = await sample(args.issue, args.instance_root)
        now = time.monotonic()
        progress = _progress_signature(row)
        if progress != last_progress:
            last_progress = progress
            last_progress_at = now
        timed_out = now >= deadline
        if row.get("pending_diagnosis") and (timed_out or now - last_progress_at >= pending_grace):
            row["diagnosis"] = list(dict.fromkeys([*row.get("diagnosis", []), *row["pending_diagnosis"]]))
            row["pending_diagnosis"] = []
        samples.append(row)
        if args.jsonl:
            args.jsonl.parent.mkdir(parents=True, exist_ok=True)
            with args.jsonl.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, sort_keys=True) + "\n")
        if _sample_successful(row):
            termination_reason = "completed"
            break
        if args.single_sample:
            termination_reason = "single_sample"
            break
        if row["diagnosis"] and args.stop_on_diagnosis:
            termination_reason = "diagnosis"
            break
        if timed_out:
            break
        await asyncio.sleep(args.interval)
    latest = samples[-1] if samples else None
    failures = _observer_failures(latest)
    result = {
        "pass": bool(latest and _sample_successful(latest)),
        "issue": args.issue,
        "instance_id": args.instance_root.name,
        "sample_count": len(samples),
        "latest": latest,
        "diagnoses": [sample["diagnosis"] for sample in samples if sample["diagnosis"]],
        "failures": failures,
        "termination_reason": termination_reason,
    }
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    return result


def _sample_successful(sample_row: dict[str, Any]) -> bool:
    return bool(
        not sample_row.get("linear_tree_error")
        and not sample_row.get("diagnosis")
        and not sample_row.get("pending_diagnosis")
        and _business_issue_successful(sample_row.get("linear_tree"))
        and _runtime_successful(sample_row.get("runtime"))
    )


def _observer_failures(sample_row: dict[str, Any] | None) -> list[str]:
    if not sample_row:
        return ["observer:no_samples"]
    failures = list(sample_row.get("diagnosis") or [])
    failures.extend(sample_row.get("pending_diagnosis") or [])
    if sample_row.get("linear_tree_error"):
        failures.append("linear_tree:fetch_failed")
    if not _business_issue_successful(sample_row.get("linear_tree")):
        failures.append("observer:business_issue_not_successful")
    if not _runtime_successful(sample_row.get("runtime")):
        failures.append("observer:managed_run_not_successful")
    return list(dict.fromkeys(failures))


def _business_issue_successful(tree: Any) -> bool:
    business = tree.get("business_issue") if isinstance(tree, dict) else None
    return str((business or {}).get("state_type") or "").lower() == "completed"


def _runtime_successful(runtime: Any) -> bool:
    if not isinstance(runtime, dict) or runtime.get("pass") is not True:
        return False
    runs = [run for run in runtime.get("runs", []) if isinstance(run, dict)]
    return bool(runs) and all(str(run.get("state") or "") == "done" for run in runs)


def _progress_signature(sample_row: dict[str, Any]) -> tuple[Any, ...]:
    runtime = sample_row.get("runtime") if isinstance(sample_row.get("runtime"), dict) else {}
    tree = sample_row.get("linear_tree") if isinstance(sample_row.get("linear_tree"), dict) else {}
    business = tree.get("business_issue") if isinstance(tree.get("business_issue"), dict) else {}
    counts = runtime.get("counts") if isinstance(runtime.get("counts"), dict) else {}
    runs = tuple(
        (str(run.get("run_id") or ""), str(run.get("state") or ""), int(run.get("plan_version") or 0))
        for run in runtime.get("runs", [])
        if isinstance(run, dict)
    )
    return (
        str(business.get("state") or ""),
        str(business.get("state_type") or ""),
        runs,
        tuple((name, int(counts.get(name) or 0)) for name in sorted(counts)),
        tuple(str(failure) for failure in runtime.get("failures", [])),
    )


def _pending_runtime_evidence(finding: str, runtime: dict[str, Any]) -> bool:
    aggregate_missing = {
        "runtime:managed_run_db_missing",
        "runtime:generation_logs_missing",
        "runtime:attempt_logs_missing",
        "runtime:turn_requests_missing",
        "runtime:turn_results_missing",
    }
    missing_instance = finding.startswith("runtime:managed_run_instance_missing:")
    missing_result = finding.startswith("runtime:turn_result_missing:")
    if finding not in aggregate_missing and not missing_instance and not missing_result:
        return False
    runs = [run for run in runtime.get("runs", []) if isinstance(run, dict)]
    if runs and all(str(run.get("state") or "") in {"blocked", "failed", "done"} for run in runs):
        return False
    if missing_result or finding == "runtime:turn_results_missing":
        return True
    counts = runtime.get("counts") if isinstance(runtime.get("counts"), dict) else {}
    runtime_file_count = sum(
        int(counts.get(name) or 0)
        for name in ("generation_logs", "attempt_logs", "turn_requests", "turn_results")
    )
    if finding == "runtime:managed_run_db_missing" or missing_instance:
        return runtime_file_count == 0
    return int(counts.get("attempts") or 0) == 0 and runtime_file_count == 0


def _linear_tree_terminal(tree: dict[str, Any] | None) -> bool:
    business_issue = tree.get("business_issue") if isinstance(tree, dict) else None
    state_type = str((business_issue or {}).get("state_type") or "").lower()
    return state_type in {"completed", "canceled"}


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Observe a real Symphony Managed Run without mutating Linear.")
    arg_parser.add_argument("--issue", required=True, help="Business issue id or identifier.")
    arg_parser.add_argument("--instance-root", type=Path, required=True, help="Conductor instance root under <data-root>/instances/.")
    arg_parser.add_argument("--interval", type=float, default=10.0)
    arg_parser.add_argument("--timeout", type=float, default=300.0)
    arg_parser.add_argument(
        "--pending-grace",
        type=float,
        default=60.0,
        help="Seconds without runtime progress before pending evidence becomes a diagnosis.",
    )
    arg_parser.add_argument("--single-sample", action="store_true")
    arg_parser.add_argument("--stop-on-diagnosis", action="store_true")
    arg_parser.add_argument("--jsonl", type=Path, help="Append every sample as JSONL.")
    arg_parser.add_argument("--out", type=Path, help="Write final observer summary JSON.")
    return arg_parser


def main() -> None:
    args = parser().parse_args()
    result = asyncio.run(observe(args))
    print(json.dumps(result, indent=2, sort_keys=True))
    if not result["pass"]:
        sys.exit(2)


if __name__ == "__main__":
    main()
