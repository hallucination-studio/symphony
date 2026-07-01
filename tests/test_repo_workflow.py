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
