from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from .catalog import ACCEPTANCE_SCENARIOS, BUSINESS_SCENARIOS, JOURNEYS, validate_catalog
from .markdown import render_catalog_markdown


def catalog_payload() -> dict[str, Any]:
    errors = validate_catalog(BUSINESS_SCENARIOS, ACCEPTANCE_SCENARIOS, JOURNEYS)
    return {
        "valid": not errors,
        "errors": errors,
        "business_scenarios": [item.to_dict() for item in BUSINESS_SCENARIOS],
        "acceptance_scenarios": [item.to_dict() for item in ACCEPTANCE_SCENARIOS],
        "journeys": [item.to_dict() for item in JOURNEYS],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="symphony_acceptance")
    subparsers = parser.add_subparsers(dest="command", required=True)
    catalog_parser = subparsers.add_parser("catalog", help="Validate and print the acceptance catalog.")
    output_group = catalog_parser.add_mutually_exclusive_group()
    output_group.add_argument("--json", action="store_true", help="Print the complete catalog as JSON.")
    output_group.add_argument("--markdown", action="store_true", help="Render the product catalog as Markdown.")
    catalog_parser.add_argument("--write", type=Path, help="Write rendered Markdown to this path.")
    args = parser.parse_args(argv)
    if args.write is not None and not args.markdown:
        parser.error("--write requires --markdown")

    payload = catalog_payload()
    if args.json:
        print(json.dumps(payload, separators=(",", ":"), sort_keys=True))
    elif args.markdown and payload["valid"]:
        rendered = render_catalog_markdown(BUSINESS_SCENARIOS, ACCEPTANCE_SCENARIOS, JOURNEYS)
        if args.write is None:
            print(rendered, end="")
        else:
            args.write.parent.mkdir(parents=True, exist_ok=True)
            args.write.write_text(rendered, encoding="utf-8")
            print(f"wrote={args.write}")
    else:
        print(
            f"valid={str(payload['valid']).lower()} "
            f"business_scenarios={len(BUSINESS_SCENARIOS)} "
            f"acceptance_scenarios={len(ACCEPTANCE_SCENARIOS)} journeys={len(JOURNEYS)}"
        )
        for error in payload["errors"]:
            print(f"error={error}")
    return 0 if payload["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
