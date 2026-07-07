from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

from linear_tree_audit import audit_tree, fetch_issue_tree
from runtime_claims_audit import audit_runtime_state, load_json


def tail_text(path: Path, max_bytes: int = 80_000) -> str:
    if not path.exists():
        return ""
    data = path.read_bytes()
    return data[-max_bytes:].decode("utf-8", errors="replace")


def runtime_paths(instance_root: Path) -> dict[str, Path]:
    return {
        "state": instance_root / "state" / "performer.json",
        "ops": instance_root / "state" / "ops.json",
        "log": instance_root / "logs" / "performer.log",
    }


async def sample(issue: str, instance_root: Path) -> dict[str, Any]:
    paths = runtime_paths(instance_root)
    tree_result: dict[str, Any] | None = None
    tree_error: str | None = None
    try:
        tree_result = audit_tree(await fetch_issue_tree(issue))
    except Exception as exc:
        tree_error = str(exc)
    log_text = tail_text(paths["log"])
    runtime_result = audit_runtime_state(load_json(paths["state"]), log_text)
    ops = load_json(paths["ops"])
    return {
        "sampled_at_unix": time.time(),
        "issue": issue,
        "instance_root": str(instance_root),
        "linear_tree": tree_result,
        "linear_tree_error": tree_error,
        "runtime": runtime_result,
        "ops_counts": {
            "issues": len(ops.get("issues", {})) if isinstance(ops.get("issues"), dict) else 0,
            "runs": len(ops.get("runs", {})) if isinstance(ops.get("runs"), dict) else 0,
            "attempts": len(ops.get("attempts", {})) if isinstance(ops.get("attempts"), dict) else 0,
            "turns": len(ops.get("turns", {})) if isinstance(ops.get("turns"), dict) else 0,
            "events": len(ops.get("events", [])) if isinstance(ops.get("events"), list) else 0,
        },
        "log_tail": log_text.splitlines()[-80:],
        "diagnosis": diagnose(tree_result, runtime_result),
    }


def diagnose(tree: dict[str, Any] | None, runtime: dict[str, Any]) -> list[str]:
    findings: list[str] = []
    findings.extend(f"runtime:{failure}" for failure in runtime.get("failures", []))
    if not tree:
        return findings
    business = tree.get("business_issue") or {}
    labels = set(business.get("labels") or [])
    description = str(business.get("description") or "")
    has_pipeline_metadata = all(
        marker in description
        for marker in ("graph_id:", "node_id:", "gate_snapshot_hash:", "conductor_revision:")
    )
    if "performer:type/task" in labels and not has_pipeline_metadata:
        findings.append("linear_tree:missing_pipeline_metadata")
    findings.extend(f"linear_tree:{failure}" for failure in tree.get("failures", []))
    return findings


async def observe(args: argparse.Namespace) -> dict[str, Any]:
    samples: list[dict[str, Any]] = []
    deadline = time.time() + args.timeout
    while True:
        row = await sample(args.issue, args.instance_root)
        samples.append(row)
        if args.jsonl:
            args.jsonl.parent.mkdir(parents=True, exist_ok=True)
            with args.jsonl.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, sort_keys=True) + "\n")
        if args.single_sample or time.time() >= deadline:
            break
        if row["diagnosis"] and args.stop_on_diagnosis:
            break
        await asyncio.sleep(args.interval)
    result = {
        "issue": args.issue,
        "instance_root": str(args.instance_root),
        "sample_count": len(samples),
        "latest": samples[-1] if samples else None,
        "diagnoses": [sample["diagnosis"] for sample in samples if sample["diagnosis"]],
    }
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    return result


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Observe a real Performer/Conductor run without mutating Linear.")
    arg_parser.add_argument("--issue", required=True, help="Business issue id or identifier.")
    arg_parser.add_argument("--instance-root", type=Path, required=True, help="Conductor instance root containing state/ and logs/.")
    arg_parser.add_argument("--interval", type=float, default=10.0)
    arg_parser.add_argument("--timeout", type=float, default=300.0)
    arg_parser.add_argument("--single-sample", action="store_true")
    arg_parser.add_argument("--stop-on-diagnosis", action="store_true")
    arg_parser.add_argument("--jsonl", type=Path, help="Append every sample as JSONL.")
    arg_parser.add_argument("--out", type=Path, help="Write final observer summary JSON.")
    return arg_parser


def main() -> None:
    args = parser().parse_args()
    result = asyncio.run(observe(args))
    print(json.dumps(result, indent=2, sort_keys=True))
    latest = result.get("latest") or {}
    if latest.get("diagnosis"):
        sys.exit(2)


if __name__ == "__main__":
    main()
