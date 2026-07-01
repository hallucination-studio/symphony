from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any

from runtime_claims_audit import audit_runtime_state, load_json


def copy_if_exists(source: Path, target: Path) -> bool:
    if not source.exists():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    return True


def read_json_if_exists(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def bundle(args: argparse.Namespace) -> dict[str, Any]:
    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    copied = {
        "business_issue": copy_if_exists(args.business_issue, out / "business-issue.json") if args.business_issue else False,
        "linear_tree": copy_if_exists(args.linear_tree, out / "linear-tree-final.json") if args.linear_tree else False,
        "observer": copy_if_exists(args.observer, out / "runtime-samples.jsonl") if args.observer else False,
        "cleanup_before": copy_if_exists(args.cleanup_before, out / "cleanup-before.json") if args.cleanup_before else False,
        "cleanup_after": copy_if_exists(args.cleanup_after, out / "cleanup-after.json") if args.cleanup_after else False,
    }
    state_path = args.instance_root / "state" / "performer.json"
    ops_path = args.instance_root / "state" / "ops.json"
    log_path = args.instance_root / "logs" / "performer.log"
    copied["performer_state"] = copy_if_exists(state_path, out / "performer-state.json")
    copied["ops"] = copy_if_exists(ops_path, out / "ops.json")
    copied["performer_log"] = copy_if_exists(log_path, out / "performer.log")

    log_text = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
    log_tail = "\n".join(log_text.splitlines()[-200:])
    (out / "performer-log-tail.txt").write_text(log_tail, encoding="utf-8")
    runtime_audit = audit_runtime_state(load_json(state_path), log_text)
    (out / "runtime-claims-audit.json").write_text(
        json.dumps(runtime_audit, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    ops = read_json_if_exists(ops_path)
    ops_summary = {
        "issues": len(ops.get("issues", {})) if isinstance(ops.get("issues"), dict) else 0,
        "runs": len(ops.get("runs", {})) if isinstance(ops.get("runs"), dict) else 0,
        "attempts": len(ops.get("attempts", {})) if isinstance(ops.get("attempts"), dict) else 0,
        "turns": len(ops.get("turns", {})) if isinstance(ops.get("turns"), dict) else 0,
        "events": len(ops.get("events", [])) if isinstance(ops.get("events"), list) else 0,
    }
    (out / "ops-summary.json").write_text(json.dumps(ops_summary, indent=2, sort_keys=True), encoding="utf-8")
    manifest = {
        "instance_root": str(args.instance_root),
        "copied": copied,
        "runtime_audit_pass": runtime_audit["pass"],
        "runtime_failures": runtime_audit["failures"],
        "ops_summary": ops_summary,
        "files": sorted(path.name for path in out.iterdir() if path.is_file()),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    return manifest


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Collect a real run evidence directory.")
    arg_parser.add_argument("--instance-root", type=Path, required=True, help="Conductor instance root containing state/ and logs/.")
    arg_parser.add_argument("--out", type=Path, required=True, help="Output evidence directory.")
    arg_parser.add_argument("--business-issue", type=Path)
    arg_parser.add_argument("--linear-tree", type=Path)
    arg_parser.add_argument("--observer", type=Path, help="Observer JSONL samples.")
    arg_parser.add_argument("--cleanup-before", type=Path)
    arg_parser.add_argument("--cleanup-after", type=Path)
    return arg_parser


def main() -> None:
    result = bundle(parser().parse_args())
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
