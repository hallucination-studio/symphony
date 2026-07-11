from __future__ import annotations

import ast
from pathlib import Path
import tomllib


ROOTS = {
    "performer_api": Path("packages/performer-api/src/performer_api"),
    "performer": Path("packages/performer/src/performer"),
    "conductor": Path("packages/conductor/src/conductor"),
    "podium": Path("packages/podium/src/podium"),
}

REMOVED_RUNTIME_MODULES = (
    "packages/performer-api/src/performer_api/phase.py",
    "packages/performer-api/src/performer_api/persistence.py",
    "packages/performer-api/src/performer_api/workflow.py",
    "tests/test_workflow_config.py",
    "tests/test_repo_workflow.py",
    "packages/conductor/src/conductor/conductor_phase.py",
    "packages/conductor/src/conductor/conductor_phase_ops.py",
    "packages/conductor/src/conductor/conductor_scheduler.py",
    "packages/conductor/src/conductor/conductor_linear_projector.py",
    "packages/conductor/src/conductor/conductor_performer_supervisor.py",
    "packages/conductor/src/conductor/conductor_phase_human_actions.py",
    "packages/conductor/src/conductor/conductor_crash_recovery.py",
    "packages/conductor/src/conductor/conductor_ingress.py",
    "packages/conductor/src/conductor/conductor_reconcile.py",
    "packages/conductor/src/conductor/conductor_remediation.py",
    "packages/conductor/src/conductor/conductor_ops.py",
    "packages/conductor/src/conductor/conductor_repository_handoff.py",
    "packages/conductor/src/conductor/conductor_service_repository_helpers.py",
    "packages/performer/src/performer/acceptance.py",
    "packages/performer/src/performer/completion_verifier.py",
    "packages/performer/src/performer/orchestrator.py",
    "packages/performer/src/performer/orchestrator_acceptance.py",
    "packages/performer/src/performer/orchestrator_acceptance_helpers.py",
    "packages/performer/src/performer/orchestrator_codex_events.py",
    "packages/performer/src/performer/orchestrator_completion.py",
    "packages/performer/src/performer/orchestrator_dispatch.py",
    "packages/performer/src/performer/orchestrator_helpers.py",
    "packages/performer/src/performer/orchestrator_human.py",
    "packages/performer/src/performer/orchestrator_reconcile.py",
    "packages/performer/src/performer/orchestrator_state.py",
    "packages/performer/src/performer/phase_executor.py",
    "packages/performer/src/performer/phase_runtime.py",
    "packages/performer/src/performer/reloader.py",
    "tests/test_conductor_ops.py",
)

LEGACY_PHASE_IDENTIFIERS = {
    "phase",
    "runtime_phase",
    "prior_phase_summary",
    "planned_phase_label",
    "implementation_phase_label",
    "review_phase_label",
    "rework_phase_label",
    "project_issue_phase",
    "issue_phase_projection_matches",
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


def _python_surface(paths: list[Path]) -> tuple[set[str], set[str], set[str]]:
    identifiers: set[str] = set()
    imports: set[str] = set()
    strings: set[str] = set()
    for path in paths:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    imports.add(node.module)
                    imports.update(f"{node.module}.{alias.name}" for alias in node.names)
                else:
                    imports.update(alias.name for alias in node.names)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                identifiers.add(node.name)
            elif isinstance(node, ast.Name):
                identifiers.add(node.id)
            elif isinstance(node, ast.Attribute):
                identifiers.add(node.attr)
            elif isinstance(node, ast.arg):
                identifiers.add(node.arg)
            elif isinstance(node, ast.keyword) and node.arg:
                identifiers.add(node.arg)
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                strings.add(node.value)
    return identifiers, imports, strings


def _python_files(*roots: Path) -> list[Path]:
    return sorted(path for root in roots for path in root.rglob("*.py"))


def _surface_findings(
    label: str,
    paths: list[Path],
    *,
    forbidden_identifiers: set[str] | None = None,
    forbidden_identifier_fragments: set[str] | None = None,
    forbidden_imports: set[str] | None = None,
    forbidden_strings: set[str] | None = None,
) -> list[str]:
    identifiers, imports, strings = _python_surface(paths)
    findings = [
        f"{label}:identifier:{name}"
        for name in sorted(identifiers & (forbidden_identifiers or set()))
    ]
    findings.extend(
        f"{label}:identifier-fragment:{fragment}:{name}"
        for fragment in sorted(forbidden_identifier_fragments or set())
        for name in sorted(identifiers)
        if fragment in name
    )
    findings.extend(
        f"{label}:import:{name}"
        for name in sorted(imports & (forbidden_imports or set()))
    )
    findings.extend(
        f"{label}:string:{value}"
        for value in sorted(forbidden_strings or set())
        if any(value in literal for literal in strings)
    )
    return findings


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


def test_role_packages_declare_their_direct_runtime_dependencies() -> None:
    conductor = tomllib.loads(Path("packages/conductor/pyproject.toml").read_text(encoding="utf-8"))
    performer = tomllib.loads(Path("packages/performer/pyproject.toml").read_text(encoding="utf-8"))

    assert "httpx>=0.27" in conductor["project"]["dependencies"]
    assert all(not dependency.startswith("httpx") for dependency in performer["project"]["dependencies"])


def test_retired_runtime_contracts_stay_removed() -> None:
    assert [path for path in REMOVED_RUNTIME_MODULES if Path(path).exists()] == []

    all_runtime = _python_files(*ROOTS.values())
    findings = _surface_findings(
        "runtime",
        all_runtime,
        forbidden_identifiers=LEGACY_PHASE_IDENTIFIERS
        | {
            "_poll_direct_dispatches",
            "_binding_for_group",
            "_start_due_removed_runtime_runs",
            "list_project_bindings_for_route",
            "queue_dispatches",
            "reconcile_dispatch_acks",
            "upsert_dispatch",
        },
        forbidden_identifier_fragments={
            "linear_webhook",
            "AgentSession",
            "agent_session",
            "supportsAgentSessions",
            "supports_agent_sessions",
            "RepositoryHandoff",
            "repository_handoff",
        },
        forbidden_imports={
            "performer_api.phase",
            "performer_api.persistence",
            "performer_api.workflow",
            "performer_api.managed_run",
            "conductor.conductor_workflow",
        },
        forbidden_strings={"performer:phase/", "ProjectIssuePhase", "RepositoryHandoff"},
    )
    findings.extend(
        _surface_findings(
            "performer",
            _python_files(ROOTS["performer"], ROOTS["performer_api"]),
            forbidden_identifiers={
                "find_acceptance_issue_for",
                "create_acceptance_issue_for",
                "ISSUE_ACCEPTANCE_RELATIONS_QUERY",
                "PerformerAcceptanceRelations",
                "set_issue_label_group",
                "fetch_candidate_issues",
                "fetch_issues_by_states",
                "PerformerCandidateIssues",
                "PerformerIssuesByStates",
                "AcceptanceConfig",
                "CompletionVerificationConfig",
                "PollingConfig",
                "WorkflowDefinition",
                "from_workflow",
                "direct_done_bypass_policy",
            },
            forbidden_strings={
                "performer:type/gate",
                "performer:type/evidence",
                "performer:type/acceptance",
                "performer:gate/",
                "performer:score/",
            },
        )
    )
    findings.extend(
        _surface_findings(
            "conductor-persistence",
            [
                Path("packages/conductor/src/conductor/conductor_models.py"),
                Path("packages/conductor/src/conductor/conductor_store.py"),
            ],
            forbidden_identifiers={
                "workflow_path",
                "workflow_profile",
                "workflow_inputs",
                "workflow_inputs_json",
                "workflow_content",
                "workflow_generation_status",
                "WorkflowGenerationStatus",
                "WorkflowValidationResult",
            },
        )
    )
    findings.extend(
        _surface_findings(
            "podium",
            _python_files(ROOTS["podium"]),
            forbidden_identifiers={
                "RunStatus",
                "RunSummary",
                "recent_runs",
                "record_run",
                "list_runs",
                "save_run",
            },
            forbidden_strings={"/api/v1/runs", "/api/runs"},
        )
    )
    findings.extend(
        _surface_findings(
            "conductor-service",
            [Path("packages/conductor/src/conductor/conductor_service_views.py")],
            forbidden_identifiers={"list_runs", "get_run", "build_run_detail"},
            forbidden_strings={"/api/runs"},
        )
    )

    assert findings == []
