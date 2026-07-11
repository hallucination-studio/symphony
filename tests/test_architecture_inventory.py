from __future__ import annotations

import json
from pathlib import Path

from tools import architecture_inventory


ROOT = Path(__file__).resolve().parents[1]


def test_invariant_owners_are_unique_stable_and_exist_as_test_nodes() -> None:
    report = architecture_inventory.build_inventory(ROOT)
    owners = report["invariant_owners"]

    assert report["errors"] == []
    assert len(owners) == 12
    assert len({row["id"] for row in owners}) == len(owners)
    assert len({row["owner"] for row in owners}) == len(owners)


def test_invariant_owner_validation_uses_ast_not_source_text(tmp_path: Path) -> None:
    test_file = tmp_path / "tests" / "test_claim.py"
    test_file.parent.mkdir()
    test_file.write_text(
        'CLAIM = "def test_only_in_string(): pass"\n\n'
        "def test_real_node():\n"
        "    pass\n",
        encoding="utf-8",
    )

    errors = architecture_inventory.validate_invariant_owners(
        tmp_path,
        (("architecture.ast_owner_check", "tests/test_claim.py::test_only_in_string"),),
    )

    assert errors == [
        "invariant_owner_function_missing:architecture.ast_owner_check:"
        "tests/test_claim.py::test_only_in_string"
    ]


def test_installed_entrypoint_reachability_partitions_every_role_module() -> None:
    report = architecture_inventory.build_inventory(ROOT)

    assert report["valid"] is True
    assert set(report["roles"]) == {"performer", "conductor", "podium"}
    assert {
        role: details["entrypoint"] for role, details in report["roles"].items()
    } == {
        "performer": "performer.cli:main",
        "conductor": "conductor.conductor_cli:main",
        "podium": "podium.cli:main",
    }
    for details in report["roles"].values():
        reachable = set(details["reachable"])
        unreachable = set(details["unreachable"])
        assert reachable.isdisjoint(unreachable)
        assert reachable | unreachable == set(details["modules"])
        assert unreachable == set()


def test_performer_inventory_has_only_retained_and_classified_legacy_modules() -> None:
    performer = architecture_inventory.build_inventory(ROOT)["roles"]["performer"]

    assert performer["reachable"] == [
        "performer",
        "performer.cli",
        "performer.codex_client",
        "performer.codex_client_helper_adapter",
        "performer.codex_client_helper_async",
        "performer.codex_client_helpers",
        "performer.codex_client_sdk_events",
        "performer.codex_client_sdk_runtime",
        "performer.codex_config",
        "performer.managed_run_backend",
        "performer.managed_run_backend_schemas",
    ]
    assert performer["legacy_candidates"] == {}
    assert performer["migration_history"] == {
        "D1.1-linear": [
            "performer.linear",
            "performer.linear_client_comments",
            "performer.linear_client_issues",
            "performer.linear_client_labels",
            "performer.linear_client_relations",
            "performer.linear_errors",
            "performer.linear_models",
            "performer.linear_queries",
            "performer.linear_tool",
            "performer.tracker",
        ],
        "D1.2-workspace": [
            "performer.repository_handoff",
            "performer.workspace",
            "performer.workspace_execution_state",
        ],
        "D1.3-telemetry": [
            "performer.agent_backend",
            "performer.ops_telemetry",
            "performer.ops_telemetry_mutations",
        ],
    }
    assert performer["unreachable"] == sorted(
        module
        for group in performer["legacy_candidates"].values()
        for module in group
    )
    assert performer["unexplained"] == []


def test_performer_partition_rejects_overlapping_ownership() -> None:
    errors = architecture_inventory.validate_performer_partition(
        ("performer", "performer.cli"),
        {
            "D1.1": ("performer.legacy", "performer.legacy"),
            "D1.2": ("performer.legacy", "performer.cli"),
        },
    )

    assert errors == [
        "performer_legacy_group_duplicate:D1.1:performer.legacy",
        "performer_legacy_groups_overlap:performer.legacy",
        "performer_retained_legacy_overlap:performer.cli",
    ]


def test_cli_prints_machine_readable_inventory(capsys) -> None:
    assert architecture_inventory.main() == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload["valid"] is True
    assert payload["roles"]["performer"]["unexplained"] == []
