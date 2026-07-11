from __future__ import annotations

import ast
import importlib.util
import json
import re
from collections import Counter
from importlib.metadata import distribution
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
ROLE_ROOTS = {
    "performer": Path("packages/performer/src/performer"),
    "conductor": Path("packages/conductor/src/conductor"),
    "podium": Path("packages/podium/src/podium"),
}

INVARIANT_OWNERS = (
    ("architecture.role_import_boundaries", "tests/test_import_boundaries.py::test_package_import_boundaries"),
    (
        "intake.baseline_cursor_pagination",
        "tests/test_podium_linear_reconciliation_pages.py::test_baseline_scan_paginates_and_commits_one_epoch_per_issue",
    ),
    (
        "intake.delegation_epoch_reopen",
        "tests/test_podium_linear_reconciliation_pages.py::test_incremental_scan_opens_new_epoch_only_after_observed_undelegation",
    ),
    (
        "intake.checkpoint_failure_recovery",
        "tests/test_podium_linear_reconciliation_pages.py::test_failed_second_page_resumes_committed_cursor_after_durable_backoff",
    ),
    (
        "topology.single_conductor_project_binding",
        "tests/test_podium_linear_project_binding.py::test_binding_ack_enforces_one_project_per_conductor_and_one_conductor_per_project",
    ),
    (
        "state.managed_run_durable_recovery",
        "tests/test_conductor_managed_run_store.py::test_managed_run_store_persists_run_plan_and_recovery_cursor",
    ),
    (
        "planning.accepted_plan_immutable",
        "tests/test_conductor_managed_run_coordinator.py::test_managed_run_coordinator_rejects_unapproved_replacement_plan_after_acceptance",
    ),
    (
        "execution.fenced_result_rejection",
        "tests/test_conductor_managed_run_driver.py::test_managed_run_driver_carries_and_rejects_fenced_turn_context",
    ),
    (
        "operator.runtime_wait_linear_projection",
        "tests/test_conductor_managed_run_human_action.py::test_runtime_wait_projects_child_issue_and_resumes_only_after_child_completion",
    ),
    (
        "observability.projection_failure_state_api_parity",
        "tests/test_conductor_managed_run_projection_sync.py::test_projection_sync_failure_is_visible_in_managed_run_state_and_api",
    ),
    (
        "security.bootstrap_response_secret_boundary",
        "tests/test_podium_bff.py::test_bootstrap_returns_sanitized_session_onboarding_and_linear_state",
    ),
    (
        "authority.managed_run_backend_has_no_linear_mutation",
        "tests/test_performer_managed_run_backend.py::test_managed_run_backend_cannot_write_linear_or_transition_work_items",
    ),
)

PERFORMER_RETAINED = (
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
)
PERFORMER_MIGRATION_HISTORY = {
    "D1.1-linear": (
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
    ),
    "D1.2-workspace": (
        "performer.repository_handoff",
        "performer.workspace",
        "performer.workspace_execution_state",
    ),
    "D1.3-telemetry": (
        "performer.agent_backend",
        "performer.ops_telemetry",
        "performer.ops_telemetry_mutations",
    ),
}


def validate_invariant_owners(
    root: Path,
    owners: Iterable[tuple[str, str]] = INVARIANT_OWNERS,
) -> list[str]:
    errors: list[str] = []
    seen_ids: set[str] = set()
    seen_owners: set[str] = set()
    for invariant_id, owner in owners:
        if not re.fullmatch(r"[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+", invariant_id):
            errors.append(f"invariant_id_invalid:{invariant_id}")
        if invariant_id in seen_ids:
            errors.append(f"invariant_id_duplicate:{invariant_id}")
        if owner in seen_owners:
            errors.append(f"invariant_owner_duplicate:{owner}")
        seen_ids.add(invariant_id)
        seen_owners.add(owner)

        try:
            relative_path, function_name = owner.split("::", 1)
        except ValueError:
            errors.append(f"invariant_owner_node_invalid:{invariant_id}:{owner}")
            continue
        path = root / relative_path
        if not path.is_file():
            errors.append(f"invariant_owner_file_missing:{invariant_id}:{relative_path}")
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        functions = {
            node.name
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        if function_name not in functions:
            errors.append(f"invariant_owner_function_missing:{invariant_id}:{owner}")
    return errors


def _module_paths(package_root: Path, role: str) -> dict[str, Path]:
    modules: dict[str, Path] = {}
    for path in package_root.rglob("*.py"):
        relative = path.relative_to(package_root)
        parts = relative.parts[:-1] if relative.name == "__init__.py" else (*relative.parts[:-1], relative.stem)
        module = ".".join((role, *parts))
        modules[module] = path
    return modules


def _installed_entrypoint(role: str) -> str:
    matches = [
        entry.value
        for entry in distribution(role).entry_points
        if entry.group == "console_scripts" and entry.name == role
    ]
    if len(matches) != 1:
        raise RuntimeError(f"installed_entrypoint_count:{role}:{len(matches)}")
    return matches[0]


def _internal_imports(module: str, path: Path, known_modules: set[str]) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    package = module if path.name == "__init__.py" else module.rpartition(".")[0]
    imported: set[str] = set()

    def include(name: str) -> None:
        candidate = name
        while candidate:
            if candidate in known_modules:
                imported.add(candidate)
            candidate = candidate.rpartition(".")[0]

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                include(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = importlib.util.resolve_name("." * node.level + (node.module or ""), package)
            else:
                base = node.module or ""
            include(base)
            for alias in node.names:
                include(f"{base}.{alias.name}")
    return imported


def _role_inventory(root: Path, role: str) -> dict[str, object]:
    modules = _module_paths(root / ROLE_ROOTS[role], role)
    known_modules = set(modules)
    entrypoint = _installed_entrypoint(role)
    entry_module = entrypoint.partition(":")[0]
    if entry_module not in modules:
        raise RuntimeError(f"entrypoint_module_missing:{role}:{entry_module}")

    reachable = {role, entry_module}
    pending = list(reachable)
    while pending:
        module = pending.pop()
        for imported in _internal_imports(module, modules[module], known_modules):
            if imported not in reachable:
                reachable.add(imported)
                pending.append(imported)

    all_modules = set(modules)
    return {
        "entrypoint": entrypoint,
        "modules": sorted(all_modules),
        "reachable": sorted(reachable),
        "unreachable": sorted(all_modules - reachable),
    }


def validate_performer_partition(
    retained: Iterable[str],
    legacy_groups: dict[str, tuple[str, ...]],
) -> list[str]:
    errors: list[str] = []
    owners_by_module: dict[str, set[str]] = {}
    for group, modules in legacy_groups.items():
        for module, count in Counter(modules).items():
            if count > 1:
                errors.append(f"performer_legacy_group_duplicate:{group}:{module}")
            owners_by_module.setdefault(module, set()).add(group)

    errors.extend(
        f"performer_legacy_groups_overlap:{module}"
        for module, owners in owners_by_module.items()
        if len(owners) > 1
    )
    errors.extend(
        f"performer_retained_legacy_overlap:{module}"
        for module in set(retained).intersection(owners_by_module)
    )
    return sorted(errors)


def build_inventory(root: Path = ROOT) -> dict[str, object]:
    errors = validate_invariant_owners(root)
    errors.extend(validate_performer_partition(PERFORMER_RETAINED, PERFORMER_MIGRATION_HISTORY))
    roles = {role: _role_inventory(root, role) for role in ROLE_ROOTS}
    errors.extend(
        f"{role}_unreachable_modules"
        for role, details in roles.items()
        if details["unreachable"]
    )

    performer = roles["performer"]
    migration_history = {
        group: list(modules) for group, modules in PERFORMER_MIGRATION_HISTORY.items()
    }
    historical_legacy = {
        module
        for modules in PERFORMER_MIGRATION_HISTORY.values()
        for module in modules
    }
    all_performer = set(performer["modules"])
    current_legacy = all_performer & historical_legacy
    legacy_candidates = {
        group: [module for module in modules if module in current_legacy]
        for group, modules in PERFORMER_MIGRATION_HISTORY.items()
        if any(module in current_legacy for module in modules)
    }
    explained = set(PERFORMER_RETAINED) | current_legacy
    performer["retained"] = list(PERFORMER_RETAINED)
    performer["legacy_candidates"] = legacy_candidates
    performer["migration_history"] = migration_history
    performer["unexplained"] = sorted(all_performer - explained)

    if set(performer["reachable"]) != set(PERFORMER_RETAINED):
        errors.append("performer_retained_closure_mismatch")
    if set(performer["unreachable"]) != current_legacy:
        errors.append("performer_legacy_candidates_mismatch")
    if all_performer != explained:
        errors.append("performer_unexplained_modules")

    return {
        "valid": not errors,
        "errors": errors,
        "invariant_owners": [
            {"id": invariant_id, "owner": owner}
            for invariant_id, owner in INVARIANT_OWNERS
        ],
        "roles": roles,
    }


def main() -> int:
    report = build_inventory()
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
