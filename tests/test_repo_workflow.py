from __future__ import annotations

from pathlib import Path

from performer_api.config import ServiceConfig, load_env_file
from performer_api.workflow import load_workflow


def test_repo_workflow_prepares_isolated_issue_workspaces() -> None:
    workflow_path = Path("WORKFLOW.md").resolve()
    load_env_file(workflow_path.parent / ".env")

    config = ServiceConfig.from_workflow(load_workflow(workflow_path), workflow_path)

    assert config.workspace.root.is_absolute()
    assert config.hooks.after_create is not None
    assert "git clone --shared --no-hardlinks ../.. ." in config.hooks.after_create


def test_repo_workflow_exposes_issue_description_to_agent() -> None:
    workflow_path = Path("WORKFLOW.md").resolve()

    workflow = load_workflow(workflow_path)

    assert "Description: {{ issue.description" in workflow.prompt_template


def test_repo_workflow_enables_acceptance_gates_by_default() -> None:
    workflow_path = Path("WORKFLOW.md").resolve()
    load_env_file(workflow_path.parent / ".env")

    workflow = load_workflow(workflow_path)
    config = ServiceConfig.from_workflow(workflow, workflow_path)

    assert config.acceptance.enabled is True
    assert config.acceptance.review_state == "In Review"
    assert config.acceptance.gate_type_label == "performer:type/gate"
    assert config.acceptance.gate_planner_mode == "strict"
    assert config.acceptance.evidence_type_label == "performer:type/evidence"
    assert "Do not move the issue to Done yourself" in workflow.prompt_template
    assert "Implementation summary:" in workflow.prompt_template
    assert "Test commands and exact output:" in workflow.prompt_template
    assert "Remaining risks:" in workflow.prompt_template
