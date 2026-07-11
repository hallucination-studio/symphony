from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from runtime_claims_audit import audit_runtime_evidence
from runtime_evidence_archive import (
    artifact_hashes,
    new_staging_directory,
    publish_directory,
    remove_staging_directory,
    stage_runtime_evidence,
    write_private_json,
)
from runtime_evidence_files import copy_sanitized_file


SUPPLIED_ARTIFACTS = {
    "business_issue": ("business-issue.json", True),
    "linear_tree": ("linear-tree-final.json", True),
    "observer": ("runtime-samples.jsonl", True),
    "cleanup_before": ("cleanup-before.json", True),
    "cleanup_after": ("cleanup-after.json", True),
    "codex_overload_probe": ("codex-overload-probe.json", False),
}


def bundle(args: argparse.Namespace) -> dict[str, Any]:
    out = args.out.resolve()
    instance_root = args.instance_root.resolve()
    data_root = instance_root.parent.parent
    instance_id = instance_root.name
    staging = new_staging_directory(out)
    try:
        runtime_copy = stage_runtime_evidence(data_root, instance_id=instance_id, destination=staging)
        supplied = _copy_supplied_artifacts(args, staging)
        runtime_audit = audit_runtime_evidence(staging, instance_id=instance_id)
        runtime_audit["managed_run_db"] = "managed_run/managed_run.db"
        write_private_json(staging / "runtime-claims-audit.json", runtime_audit)
        runtime_failures = [
            f"{failure['error_code']}:{failure['artifact']}"
            for failure in runtime_copy["failures"]
        ]
        supplied_failures = [
            f"required_supplied_artifact_{entry['status']}:{name}"
            for name, entry in supplied.items()
            if entry["required"] and entry["status"] != "copied"
        ]
        failures = _unique([*runtime_audit["failures"], *runtime_failures, *supplied_failures])
        runtime_artifacts_pass = bool(runtime_audit["pass"] and not runtime_copy["failures"])
        bundle_valid = bool(
            runtime_artifacts_pass
            and all(not entry["required"] or entry["status"] == "copied" for entry in supplied.values())
        )
        copied = {
            **runtime_copy["copied"],
            **{name: entry["status"] == "copied" for name, entry in supplied.items()},
        }
        files = [*_relative_files(staging), "manifest.json"]
        manifest = {
            "pass": bundle_valid,
            "bundle_valid": bundle_valid,
            "runtime_artifacts_pass": runtime_artifacts_pass,
            "instance_id": instance_id,
            "copied": copied,
            "supplied": supplied,
            "runtime_audit_pass": runtime_audit["pass"],
            "failures": failures,
            "counts": runtime_audit["counts"],
            "files": sorted(files),
            "sha256": artifact_hashes(staging),
            "hash_scope": "all artifact files except manifest.json",
        }
        write_private_json(staging / "manifest.json", manifest)
        publish_directory(staging, out)
        return manifest
    finally:
        remove_staging_directory(staging)


def _copy_supplied_artifacts(args: argparse.Namespace, out: Path) -> dict[str, dict[str, Any]]:
    supplied: dict[str, dict[str, Any]] = {}
    for name, (filename, required) in SUPPLIED_ARTIFACTS.items():
        source = getattr(args, name, None)
        entry: dict[str, Any] = {"required": required, "status": "missing"}
        if source is None:
            supplied[name] = entry
            continue
        if not isinstance(source, Path) or not source.is_file():
            entry["status"] = "missing"
            supplied[name] = entry
            continue
        try:
            copy_sanitized_file(source, out / filename)
        except OSError as exc:
            entry.update({"status": "archive_failed", "error_type": type(exc).__name__})
        else:
            entry["status"] = "copied"
        supplied[name] = entry
    return supplied


def _relative_files(root: Path) -> list[str]:
    return sorted(path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file())


def _unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(
        description="Collect and validate a Managed Run runtime-artifact archive; this is not final journey acceptance."
    )
    arg_parser.add_argument("--instance-root", type=Path, required=True, help="Conductor instance root under <data-root>/instances/.")
    arg_parser.add_argument("--out", type=Path, required=True, help="Output evidence directory.")
    arg_parser.add_argument("--business-issue", type=Path)
    arg_parser.add_argument("--linear-tree", type=Path)
    arg_parser.add_argument("--observer", type=Path, help="Observer JSONL samples.")
    arg_parser.add_argument("--cleanup-before", type=Path)
    arg_parser.add_argument("--cleanup-after", type=Path)
    arg_parser.add_argument("--codex-overload-probe", type=Path)
    return arg_parser


def main() -> None:
    result = bundle(parser().parse_args())
    print(json.dumps(result, indent=2, sort_keys=True))
    if not result["pass"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
