from __future__ import annotations

import ast
import importlib
import importlib.util
from pathlib import Path

import pytest

from performer_api import managed_runs


REMOVED_FACADE_EXPORTS = {
    "CanonicalAgentEvent",
    "CanonicalAgentEventType",
    "GateSnapshot",
    "GateStep",
    "GateStepSource",
    "LinearChangeClass",
    "LinearRevisionAction",
    "MANAGED_RUN_BACKENDS_BY_ROLE",
    "ManagedRunState",
    "RUN_SUMMARY_END",
    "RUN_SUMMARY_START",
    "RevisionDecision",
    "SECRET_SETTING_KEYS",
    "TaskOutputManifest",
    "ThreadCompletionReport",
    "VerificationInputSnapshot",
    "WorkItemState",
    "render_run_summary_block",
    "replace_managed_run_summary_block",
    "sanitize_profile_settings",
}

SHARED_WIRE_EXPORTS = {
    "ChangedFile",
    "Checkpoint",
    "ManagedRunCapacity",
    "ManagedRunPlan",
    "ManagedRunPlanValidator",
    "ManagedRunPlanValidatorError",
    "ManagedRunPolicy",
    "ManagedRunRuntimeRole",
    "ManagedRunRuntimeWait",
    "ManagedRunTurnContext",
    "ParallelizationPolicy",
    "RuntimeConfigEnvelope",
    "RuntimeProfile",
    "VerificationRubric",
    "WorkItem",
    "WorkItemResult",
    "WorkItemResultStatus",
    "WorkItemSliceType",
    "WorkItemVerification",
}


def test_conductor_owns_managed_run_states() -> None:
    state = importlib.import_module("conductor.conductor_managed_run_state")

    assert {"ManagedRunState", "WorkItemState"} <= set(state.__all__)
    assert state.ManagedRunState.__module__ == state.__name__
    assert state.WorkItemState.__module__ == state.__name__


def test_conductor_store_has_no_arbitrary_work_item_payload_mutation() -> None:
    store = importlib.import_module("conductor.conductor_managed_run_store")

    assert not hasattr(store.ConductorManagedRunStore, "update_work_item_payload")


def test_conductor_owns_managed_run_gates() -> None:
    gates = importlib.import_module("conductor.conductor_managed_run_gates")

    assert {
        "GateSnapshot",
        "GateStep",
        "GateStepSource",
        "TaskOutputManifest",
        "VerificationInputSnapshot",
    } <= set(gates.__all__)
    assert all(
        getattr(gates, name).__module__ == gates.__name__
        for name in gates.__all__
    )


def test_conductor_owns_managed_run_summary() -> None:
    summary = importlib.import_module("conductor.conductor_managed_run_summary")

    assert {
        "ThreadCompletionReport",
        "render_run_summary_block",
        "replace_managed_run_summary_block",
    } <= set(summary.__all__)
    assert all(
        getattr(summary, name).__module__ == summary.__name__
        for name in summary.__all__
    )


def test_shared_managed_run_facade_is_exactly_the_wire_contract() -> None:
    assert len(managed_runs.__all__) == 19
    assert set(managed_runs.__all__) == SHARED_WIRE_EXPORTS
    assert all(not hasattr(managed_runs, name) for name in REMOVED_FACADE_EXPORTS)


def test_removed_shared_owner_modules_are_absent() -> None:
    for module_name in (
        "performer_api.config",
        "performer_api.config_utils",
        "performer_api.labels",
        "performer_api.managed_runs_gates",
        "performer_api.managed_runs_summary",
        "performer_api.models",
    ):
        assert importlib.util.find_spec(module_name) is None
        with pytest.raises(ModuleNotFoundError):
            importlib.import_module(module_name)


def test_removed_shared_types_are_absent() -> None:
    enums = importlib.import_module("performer_api.managed_runs_enums")
    results = importlib.import_module("performer_api.managed_runs_results")
    runtime = importlib.import_module("performer_api.managed_runs_runtime")
    utils = importlib.import_module("performer_api.managed_runs_utils")
    assert all(
        not hasattr(enums, name)
        for name in {
            "CanonicalAgentEventType",
            "LinearChangeClass",
            "LinearRevisionAction",
            "ManagedRunState",
            "RUN_SUMMARY_END",
            "RUN_SUMMARY_START",
            "SECRET_SETTING_KEYS",
            "WorkItemState",
        }
    )
    assert all(
        not hasattr(results, name)
        for name in {"CanonicalAgentEvent", "RevisionDecision", "ThreadCompletionReport"}
    )
    assert not hasattr(utils, "sanitize_profile_settings")
    assert not hasattr(runtime.RuntimeProfile, "sanitized")
    assert not hasattr(runtime.RuntimeConfigEnvelope, "sanitized")


def test_production_ast_does_not_import_removed_shared_contracts() -> None:
    removed_modules = {
        "performer_api.config",
        "performer_api.config_utils",
        "performer_api.labels",
        "performer_api.models",
    }
    removed_symbols = {
        "CanonicalAgentEvent",
        "CanonicalAgentEventType",
        "LinearChangeClass",
        "LinearRevisionAction",
        "RUN_SUMMARY_END",
        "RUN_SUMMARY_START",
        "RevisionDecision",
        "SECRET_SETTING_KEYS",
        "sanitize_profile_settings",
    }
    managed_run_modules = {
        "performer_api.managed_runs",
        "performer_api.managed_runs_enums",
        "performer_api.managed_runs_results",
        "performer_api.managed_runs_runtime",
        "performer_api.managed_runs_utils",
    }
    offenders: list[str] = []
    for root in (
        Path("packages/performer-api/src"),
        Path("packages/performer/src"),
        Path("packages/conductor/src"),
        Path("packages/podium/src"),
    ):
        for path in root.rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            module_parts = path.relative_to(root).with_suffix("").parts
            if module_parts[-1] == "__init__":
                module_parts = module_parts[:-1]
                package = ".".join(module_parts)
            else:
                package = ".".join(module_parts[:-1])
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        if alias.name in removed_modules:
                            offenders.append(f"{path}:{node.lineno}:{alias.name}")
                elif isinstance(node, ast.ImportFrom):
                    imported_module = node.module or ""
                    if node.level:
                        imported_module = importlib.util.resolve_name(
                            f"{'.' * node.level}{imported_module}",
                            package,
                        )
                    if imported_module in removed_modules:
                        offenders.append(f"{path}:{node.lineno}:{imported_module}")
                    for alias in node.names:
                        imported_name = f"{imported_module}.{alias.name}"
                        if imported_name in removed_modules:
                            offenders.append(f"{path}:{node.lineno}:{imported_name}")
                    if imported_module in managed_run_modules:
                        for alias in node.names:
                            if alias.name in removed_symbols:
                                offenders.append(f"{path}:{node.lineno}:{imported_module}.{alias.name}")

    assert offenders == []
