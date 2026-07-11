from __future__ import annotations

from collections.abc import Iterable

from .models import AcceptanceScenarioSpec, BusinessScenarioSpec, JourneySpec


def render_catalog_markdown(
    businesses: tuple[BusinessScenarioSpec, ...],
    scenarios: tuple[AcceptanceScenarioSpec, ...],
    journeys: tuple[JourneySpec, ...],
) -> str:
    lines = [
        "<!-- Generated file; do not edit manually. -->",
        "",
        "# Symphony Acceptance Catalog",
        "",
        "The executable definitions in `tools/symphony_acceptance/catalog.py` are authoritative.",
        "Regenerate this document after changing them:",
        "",
        "```bash",
        "PYTHONPATH=tools .venv/bin/python -m symphony_acceptance catalog --markdown \\",
        "  --write docs/product/acceptance-catalog.md",
        "```",
        "",
        "## Business Scenarios",
        "",
        "| ID | Actor | Customer job | Start state | Accepted outcome | Visible artifacts |",
        "|---|---|---|---|---|---|",
    ]
    lines.extend(
        f"| `{item.id}` | `{item.actor}` | {_text(item.customer_job)} | `{item.start_state}` | "
        f"`{item.accepted_outcome}` | {_codes(item.visible_artifacts)} |"
        for item in businesses
    )
    lines.extend(
        (
            "",
            "## Focused Acceptance Scenarios",
            "",
            "| ID | Proves | Business scenarios | Level | Real boundaries | Authority oracles | Operator oracles | Required evidence | Cleanup | Triggers | Dependencies |",
            "|---|---|---|---|---|---|---|---|---|---|---|",
        )
    )
    lines.extend(
        f"| `{item.id}` | {_text(item.proves)} | {_codes(item.business_scenarios)} | `{item.minimum_level}` | "
        f"{_codes(item.real_boundaries)} | {_codes(item.authoritative_oracles)} | {_codes(item.operator_oracles)} | "
        f"{_codes(item.required_evidence)} | {_codes(item.cleanup)} | {_codes(item.trigger_tags)} | "
        f"{_codes(item.depends_on)} |"
        for item in scenarios
    )
    lines.extend(
        (
            "",
            "## Customer Journeys",
            "",
            "| ID | Proves | Business scenarios | Preconditions | Level | Real boundaries | Authority oracles | Operator oracles | Required evidence | Cleanup | Triggers | Dependencies |",
            "|---|---|---|---|---|---|---|---|---|---|---|---|",
        )
    )
    lines.extend(
        f"| `{item.id}` | {_text(item.proves)} | {_codes(item.business_scenarios)} | {_codes(item.preconditions)} | "
        f"`{item.minimum_level}` | {_codes(item.real_boundaries)} | {_codes(item.authoritative_oracles)} | "
        f"{_codes(item.operator_oracles)} | {_codes(item.required_evidence)} | {_codes(item.cleanup)} | "
        f"{_codes(item.trigger_tags)} | {_codes(item.depends_on)} |"
        for item in journeys
    )
    return "\n".join(lines) + "\n"


def _codes(values: Iterable[str]) -> str:
    rendered = ", ".join(f"`{_text(value)}`" for value in values)
    return rendered or "-"


def _text(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")
