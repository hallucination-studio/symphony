from __future__ import annotations

from pathlib import Path


def test_runtime_architecture_doc_is_pipeline_only() -> None:
    path = Path("docs/product/runtime-orchestration-architecture.md")
    text = path.read_text(encoding="utf-8")

    assert "Superseded by `docs/product/three-mode-runtime-pipeline.md`" in text
    assert "direct mode" not in text.lower()
    assert "phase state" not in text.lower()
    assert "phase-oriented" not in text.lower()
    assert "phase executor" not in text.lower()


def test_readme_does_not_publish_workflow_management_api_surface() -> None:
    text = Path("README.md").read_text(encoding="utf-8")

    assert "preview-workflow" not in text
    assert "generate-workflow" not in text
    assert "validate-workflow" not in text
    assert "workflow-profiles" not in text


def test_agent_guides_do_not_publish_legacy_runtime_entrypoints() -> None:
    docs = [
        Path("AGENTS.md"),
        Path("AGENT.md"),
        Path("CLAUDE.md"),
    ]

    forbidden = [
        "make once",
        ".venv/bin/performer WORKFLOW.md",
        "--dispatch-issue-id",
        "direct Performer polling loop",
        "direct/legacy polling mode",
        "Keep repo-owned workflow behavior in `WORKFLOW.md`",
    ]

    for path in docs:
        text = path.read_text(encoding="utf-8")
        for phrase in forbidden:
            assert phrase not in text, f"{path} still publishes {phrase!r}"


def test_root_docs_md_is_not_runtime_architecture_guidance() -> None:
    text = Path("docs.md").read_text(encoding="utf-8")

    assert "Historical legacy spec" in text
    assert "Do not use this file" in text
    assert "WORKFLOW.md" not in text
    assert "Poll the issue tracker" not in text
    assert "Polling orchestrator" not in text


def test_linear_tree_skill_doc_is_offline_pipeline_importer_only() -> None:
    path = Path("docs/product/symphony-linear-tree-skill.md")
    text = path.read_text(encoding="utf-8")
    lower = text.lower()

    assert "optional offline pipeline plan importer" in lower
    assert "phase-parent" not in lower
    assert "phase parent" not in lower
    assert "phase sections" not in lower
    assert "phase issues" not in lower
    assert "phase:" not in lower
    assert "primary decomposition path" not in lower


def test_docs_do_not_publish_legacy_workflow_or_phase_instructions() -> None:
    forbidden = [
        "performer WORKFLOW",
        "WORKFLOW.md --once",
        "--once",
        "phase_runs",
        "runtime_phase",
        "orchestration_runs",
        "direct polling",
    ]
    allowed_paths = {
        Path("docs/product/three-mode-runtime-pipeline.md"),
        Path("docs/product/symphony-linear-tree-skill.md"),
    }

    for path in Path("docs").rglob("*.md"):
        if path in allowed_paths:
            continue
        text = path.read_text(encoding="utf-8")
        for phrase in forbidden:
            assert phrase not in text, f"{path} still publishes {phrase!r}"
