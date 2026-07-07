from __future__ import annotations

import ast
import importlib
from pathlib import Path


ROOTS = {
    "performer_api": Path("packages/performer-api/src/performer_api"),
    "performer": Path("packages/performer/src/performer"),
    "conductor": Path("packages/conductor/src/conductor"),
    "podium": Path("packages/podium/src/podium"),
}


def _imports(root: Path) -> set[str]:
    found: set[str] = set()
    for path in root.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                found.update(alias.name.split(".", 1)[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                found.add(node.module.split(".", 1)[0])
    return found


def test_package_import_boundaries() -> None:
    imports = {name: _imports(path) for name, path in ROOTS.items()}

    assert not (imports["performer_api"] & {"performer", "conductor", "podium"})
    assert not (imports["performer"] & {"conductor", "podium"})
    assert not (imports["conductor"] & {"performer", "podium"})
    assert not (imports["podium"] & {"performer", "conductor"})
    assert "performer_api" in imports["performer"]
    assert "performer_api" in imports["conductor"]
    assert "performer_api" in imports["podium"]


def test_performer_does_not_write_authoritative_phase_labels() -> None:
    offenders: list[str] = []
    for path in ROOTS["performer"].rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        if '_sync_label_group' in text and 'prefix="performer:phase/"' in text:
            offenders.append(str(path))

    assert offenders == []


def test_product_runtime_entrypoints_do_not_import_legacy_phase_modules() -> None:
    legacy_modules = {
        "performer_api.phase",
        "performer_api.persistence",
        "conductor.conductor_phase",
        "conductor.conductor_phase_ops",
        "conductor.conductor_scheduler",
        "conductor.conductor_linear_projector",
        "conductor.conductor_performer_supervisor",
        "conductor.conductor_phase_human_actions",
        "conductor.conductor_reconcile",
        "conductor.conductor_remediation",
    }
    entrypoints = [
        "performer.cli",
        "conductor.conductor_service",
        "conductor.conductor_podium_sync",
    ]

    for module_name in entrypoints:
        module = importlib.import_module(module_name)
        imports = {
            node.module
            for node in ast.walk(ast.parse(Path(module.__file__).read_text(encoding="utf-8")))
            if isinstance(node, ast.ImportFrom) and node.module
        }
        assert legacy_modules.isdisjoint(imports), module_name


def test_legacy_phase_runtime_modules_are_removed() -> None:
    removed = [
        Path("packages/performer-api/src/performer_api/phase.py"),
        Path("packages/performer-api/src/performer_api/persistence.py"),
        Path("packages/conductor/src/conductor/conductor_phase.py"),
        Path("packages/conductor/src/conductor/conductor_phase_ops.py"),
        Path("packages/conductor/src/conductor/conductor_scheduler.py"),
        Path("packages/conductor/src/conductor/conductor_linear_projector.py"),
        Path("packages/conductor/src/conductor/conductor_performer_supervisor.py"),
        Path("packages/conductor/src/conductor/conductor_phase_human_actions.py"),
        Path("packages/conductor/src/conductor/conductor_crash_recovery.py"),
        Path("packages/conductor/src/conductor/conductor_ingress.py"),
        Path("packages/conductor/src/conductor/conductor_reconcile.py"),
        Path("packages/conductor/src/conductor/conductor_remediation.py"),
        Path("packages/performer/src/performer/orchestrator.py"),
        Path("packages/performer/src/performer/orchestrator_acceptance.py"),
        Path("packages/performer/src/performer/orchestrator_acceptance_helpers.py"),
        Path("packages/performer/src/performer/orchestrator_codex_events.py"),
        Path("packages/performer/src/performer/orchestrator_completion.py"),
        Path("packages/performer/src/performer/orchestrator_dispatch.py"),
        Path("packages/performer/src/performer/orchestrator_helpers.py"),
        Path("packages/performer/src/performer/orchestrator_human.py"),
        Path("packages/performer/src/performer/orchestrator_reconcile.py"),
        Path("packages/performer/src/performer/orchestrator_state.py"),
        Path("packages/performer/src/performer/phase_executor.py"),
        Path("packages/performer/src/performer/phase_runtime.py"),
        Path("packages/performer/src/performer/reloader.py"),
    ]

    assert [str(path) for path in removed if path.exists()] == []


def test_runtime_phase_is_not_a_product_contract() -> None:
    hits: list[str] = []
    for root in ROOTS.values():
        for path in root.rglob("*.py"):
            if "runtime_phase" in path.read_text(encoding="utf-8"):
                hits.append(str(path))

    assert hits == []


def test_product_runtime_code_does_not_expose_phase_state_fields() -> None:
    allowed_files = {
        Path("packages/performer-api/src/performer_api/config.py"),
        Path("packages/performer/src/performer/linear_models.py"),
    }
    forbidden = {
        '"phase"',
        ".phase",
        "phase:",
        " phase ",
        "_phase_",
        "phase_",
        "prior_phase_summary",
    }
    hits: list[str] = []
    for root in ROOTS.values():
        for path in root.rglob("*.py"):
            if path in allowed_files:
                continue
            text = path.read_text(encoding="utf-8")
            if any(symbol in text for symbol in forbidden):
                hits.append(str(path))

    assert hits == []


def test_shared_config_does_not_publish_phase_named_acceptance_fields() -> None:
    config_source = (ROOTS["performer_api"] / "config.py").read_text(encoding="utf-8")
    forbidden = [
        "planned_phase_label",
        "implementation_phase_label",
        "review_phase_label",
        "rework_phase_label",
    ]

    assert [symbol for symbol in forbidden if symbol in config_source] == []


def test_shared_config_does_not_publish_legacy_acceptance_or_completion_contracts() -> None:
    config_source = (ROOTS["performer_api"] / "config.py").read_text(encoding="utf-8")
    forbidden = [
        "AcceptanceConfig",
        "CompletionVerificationConfig",
        "acceptance:",
        "completion_verification",
        "gate_type_label",
        "evidence_type_label",
        "gate_pending_label",
        "score_label_prefix",
    ]

    assert [symbol for symbol in forbidden if symbol in config_source] == []


def test_shared_labels_do_not_publish_legacy_gate_tree_labels() -> None:
    labels_source = (ROOTS["performer_api"] / "labels.py").read_text(encoding="utf-8")
    forbidden = [
        "performer:type/gate",
        "performer:type/evidence",
        "performer:type/acceptance",
        "performer:gate/",
        "performer:score/",
        "GATE_LABELS",
        "SCORE_LABEL_PREFIX",
    ]

    assert [symbol for symbol in forbidden if symbol in labels_source] == []


def test_performer_product_code_does_not_publish_legacy_acceptance_modules_or_linear_apis() -> None:
    removed = [
        Path("packages/performer/src/performer/acceptance.py"),
        Path("packages/performer/src/performer/completion_verifier.py"),
    ]
    assert [str(path) for path in removed if path.exists()] == []

    forbidden = {
        "find_acceptance_issue_for",
        "create_acceptance_issue_for",
        "ISSUE_ACCEPTANCE_RELATIONS_QUERY",
        "PerformerAcceptanceRelations",
        "set_issue_label_group",
        "performer:type/acceptance",
    }
    hits: list[str] = []
    for root in [ROOTS["performer"], ROOTS["performer_api"]]:
        for path in root.rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            for symbol in forbidden:
                if symbol in text:
                    hits.append(f"{path}:{symbol}")

    assert hits == []


def test_shared_config_does_not_publish_legacy_polling_or_direct_done_contracts() -> None:
    config_source = (ROOTS["performer_api"] / "config.py").read_text(encoding="utf-8")
    forbidden = [
        "PollingConfig",
        "polling:",
        "_polling_config",
        "active_states",
        "direct_done_bypass_policy",
    ]

    assert [symbol for symbol in forbidden if symbol in config_source] == []


def test_product_code_does_not_expose_phase_label_projection_contracts() -> None:
    forbidden = {
        "performer:phase/",
        "project_issue_phase",
        "issue_phase_projection_matches",
        "_poll_direct_dispatches",
        "_start_due_removed_runtime_runs",
    }
    hits: list[str] = []
    for root in ROOTS.values():
        for path in root.rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            if any(symbol in text for symbol in forbidden):
                hits.append(str(path))

    assert hits == []


def test_product_runtime_surfaces_do_not_expose_legacy_phase_coordination_fields() -> None:
    forbidden = {
        "phase_runs_started",
        "phase_results_applied",
        "phase_timeouts",
        "phase_crash_retries",
        "phase_crash_failures",
        "phase_failure_human_actions_created",
        "phase_human_actions_completed",
        "phase_human_actions_missing_response",
        "phase_human_actions_failed",
        "linear_phase_projections",
        "reconcile_linear_phase_projections_once",
        "_start_orchestration_run",
        "legacy_phase_removed",
    }
    hits: list[str] = []
    for root in ROOTS.values():
        for path in root.rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            if any(symbol in text for symbol in forbidden):
                hits.append(str(path))

    assert hits == []


def test_product_runtime_does_not_import_workflow_file_contracts() -> None:
    forbidden_modules = {
        "performer_api.workflow",
        "conductor.conductor_workflow",
    }
    runtime_roots = [
        ROOTS["performer"],
        ROOTS["conductor"],
        ROOTS["podium"],
    ]
    hits: list[str] = []
    for root in runtime_roots:
        for path in root.rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        if alias.name in forbidden_modules:
                            hits.append(f"{path}:{alias.name}")
                elif isinstance(node, ast.ImportFrom) and node.module in forbidden_modules:
                    hits.append(f"{path}:{node.module}")

    assert hits == []


def test_product_runtime_does_not_expose_direct_linear_polling_interfaces() -> None:
    forbidden = {
        "fetch_candidate_issues",
        "fetch_issues_by_states",
        "PerformerCandidateIssues",
        "PerformerIssuesByStates",
    }
    hits: list[str] = []
    for root in [ROOTS["performer"], ROOTS["conductor"]]:
        for path in root.rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            for symbol in forbidden:
                if symbol in text:
                    hits.append(f"{path}:{symbol}")

    assert hits == []


def test_shared_contract_does_not_publish_workflow_file_api() -> None:
    removed = [
        Path("packages/performer-api/src/performer_api/workflow.py"),
        Path("tests/test_workflow_config.py"),
        Path("tests/test_repo_workflow.py"),
    ]
    assert [str(path) for path in removed if path.exists()] == []

    config_source = (ROOTS["performer_api"] / "config.py").read_text(encoding="utf-8")
    forbidden = [
        "WorkflowDefinition",
        "from_workflow",
        "prompt_template",
        "workflow_path",
    ]
    assert [symbol for symbol in forbidden if symbol in config_source] == []


def test_conductor_instance_persistence_has_no_workflow_fields() -> None:
    forbidden = [
        "workflow_path",
        "workflow_profile",
        "workflow_inputs",
        "workflow_inputs_json",
        "workflow_content",
        "workflow_generation_status",
        "WorkflowGenerationStatus",
        "WorkflowValidationResult",
    ]
    hits: list[str] = []
    for path in [
        Path("packages/conductor/src/conductor/conductor_models.py"),
        Path("packages/conductor/src/conductor/conductor_store.py"),
    ]:
        text = path.read_text(encoding="utf-8")
        hits.extend(f"{path}:{symbol}" for symbol in forbidden if symbol in text)

    assert hits == []


def test_podium_product_surfaces_do_not_expose_legacy_runs_contracts() -> None:
    forbidden_substrings = {
        "RunStatus",
        "RunSummary",
        "/api/v1/runs",
        "recentRuns",
        "recent_runs",
        "record_run",
        "list_runs",
    }
    paths = [
        *ROOTS["podium"].rglob("*.py"),
        *Path("packages/podium/web/src").rglob("*.ts"),
        *Path("packages/podium/web/src").rglob("*.tsx"),
    ]
    allowed = {
        Path("packages/podium/web/src/App.test.tsx"),
    }
    hits: list[str] = []
    for path in paths:
        if path in allowed:
            continue
        text = path.read_text(encoding="utf-8")
        for symbol in forbidden_substrings:
            if symbol in text:
                hits.append(f"{path}:{symbol}")
        tree = ast.parse(text, filename=str(path)) if path.suffix == ".py" else None
        if tree is not None:
            for node in ast.walk(tree):
                if isinstance(node, ast.FunctionDef) and node.name == "save_run":
                    hits.append(f"{path}:def save_run")
                elif isinstance(node, ast.Attribute) and node.attr == "save_run":
                    hits.append(f"{path}:.save_run")

    assert hits == []


def test_conductor_service_does_not_expose_legacy_run_views() -> None:
    source = Path("packages/conductor/src/conductor/conductor_service_views.py").read_text(
        encoding="utf-8"
    )
    forbidden = [
        "def list_runs(",
        "def get_run(",
        "build_run_detail",
        '"/api/runs"',
    ]

    assert [symbol for symbol in forbidden if symbol in source] == []
