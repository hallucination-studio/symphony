from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys

from performer_api.turns import PerformerTurnRequest, PerformerTurnResult

from .backend_registry import BackendRegistry, DEFAULT_BACKEND_REGISTRY
from .control_host import run_control_host


async def run_turn(
    turn_request_path: Path,
    turn_result_path: Path,
    *,
    registry: BackendRegistry | None = None,
) -> dict[str, object]:
    payload = _read_json_object(turn_request_path, "turn request")
    request = PerformerTurnRequest.from_dict(payload)
    selected_registry = registry or DEFAULT_BACKEND_REGISTRY
    backend = selected_registry.create(request.performer_kind)
    result = await backend.run_turn(request)
    if not isinstance(result, PerformerTurnResult):
        raise RuntimeError("performer_result_invalid")
    body = result.to_dict()
    _write_json_atomic(turn_result_path, body)
    return body


def _read_json_object(path: Path, label: str) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"{label.replace(' ', '_')}_invalid") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"{label.replace(' ', '_')}_invalid")
    return payload


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments and arguments[0] == "control":
        parser = argparse.ArgumentParser(description="Run the Performer control host.")
        parser.add_argument("control", nargs="?", default="control")
        parser.add_argument("--performer-kind", default="codex")
        return parser.parse_args(arguments)
    parser = argparse.ArgumentParser(description="Run one Symphony managed-run turn.")
    parser.add_argument("--turn-request-path", required=True, help="Read one managed-run turn request JSON file.")
    parser.add_argument("--turn-result-path", required=True, help="Write one managed-run turn result JSON file.")
    return parser.parse_args(arguments)


def _write_json_atomic(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if getattr(args, "control", None) == "control":
            backend = DEFAULT_BACKEND_REGISTRY.create(args.performer_kind)
            return asyncio.run(
                run_control_host(
                    backend,
                    stdin=sys.stdin.buffer,
                    stdout=sys.stdout.buffer,
                    stderr=sys.stderr.buffer,
                )
            )
        asyncio.run(
            run_turn(
                Path(args.turn_request_path).resolve(),
                Path(args.turn_result_path).resolve(),
            )
        )
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        code = str(getattr(exc, "code", "") or "").strip()
        if code not in {
            "invalid_runtime_policy",
            "performer_backend_kind_mismatch",
            "performer_backend_unsupported",
            "performer_result_invalid",
            "turn_request_invalid",
            "turn_result_invalid",
        }:
            code = "performer_startup_failed"
        print(
            json.dumps(
                {
                    "event": "performer_startup_failed",
                    "error_code": code,
                    "sanitized_reason": "The Performer process could not start the requested operation.",
                    "action_required": True,
                    "retryable": False,
                    "next_action": "inspect_performer_configuration",
                },
                separators=(",", ":"),
                sort_keys=True,
            ),
            file=sys.stderr,
            flush=True,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
