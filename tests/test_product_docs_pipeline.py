from __future__ import annotations

from pathlib import Path


PRODUCT_DOCS = {
    "README.md",
    "product-shape.md",
    "runtime-pipeline.md",
    "pipeline-state.md",
    "gates-verification-integration.md",
    "linear-projection.md",
    "runtime-profiles-backends.md",
    "linear-integration.md",
    "podium-web.md",
    "runtime-installation.md",
    "security-model.md",
}

REMOVED_DOCS = {
    Path("docs/product/three-mode-runtime-pipeline.md"),
    Path("docs/product/runtime-orchestration-architecture.md"),
    Path("docs/product/linear-podium-integration.md"),
    Path("docs/product/linear-topology-mirror.md"),
    Path("docs/product/podium-web-onboarding.md"),
    Path("docs/product/runtime-installer-and-updates.md"),
    Path("docs/product/symphony-linear-tree-skill.md"),
}

ENTRYPOINT_DOCS = [
    Path("README.md"),
    Path("AGENTS.md"),
    Path("AGENT.md"),
    Path("CLAUDE.md"),
    Path("docs.md"),
]


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_product_docs_are_current_focused_set() -> None:
    actual = {path.name for path in Path("docs/product").glob("*.md")}

    assert actual == PRODUCT_DOCS
    for path in REMOVED_DOCS:
        assert not path.exists(), f"{path} should not be preserved as a pointer"


def test_implemented_superpower_plans_are_removed() -> None:
    assert list(Path("docs/superpowers/plans").glob("*.md")) == []


def test_product_readme_links_to_source_of_truth_docs() -> None:
    text = _read(Path("docs/product/README.md"))

    for doc in PRODUCT_DOCS - {"README.md"}:
        assert f"./{doc}" in text or f"../{doc}" in text
    assert "../real-run-testing-guide.md" in text


def test_entrypoints_reference_new_runtime_docs() -> None:
    required = [
        "docs/product/runtime-pipeline.md",
        "docs/product/pipeline-state.md",
        "docs/product/gates-verification-integration.md",
        "docs/product/linear-projection.md",
        "docs/product/runtime-profiles-backends.md",
    ]
    removed_names = [str(path) for path in REMOVED_DOCS]

    for path in ENTRYPOINT_DOCS:
        text = _read(path)
        for doc in required:
            assert doc in text, f"{path} does not point to {doc}"
        for removed in removed_names:
            assert removed not in text, f"{path} still points to removed {removed}"


def test_docs_do_not_contain_historical_status_language() -> None:
    stale_phrases = [
        "present-partial",
        "L done when",
        "Current:",
        "Open questions for implementation",
        "marker-keyed",
        "Definition of Done per Feature",
        "Subproject Build Order",
        "Documents Evolved or Superseded",
    ]
    docs = list(Path("docs/product").glob("*.md")) + [Path("docs/real-run-testing-guide.md")]

    for path in docs:
        text = _read(path)
        for phrase in stale_phrases:
            assert phrase not in text, f"{path} still contains historical phrase {phrase!r}"


def test_product_docs_stay_compact() -> None:
    for path in Path("docs/product").glob("*.md"):
        line_count = len(_read(path).splitlines())
        assert line_count <= 170, f"{path} has {line_count} lines"

    real_run_lines = len(_read(Path("docs/real-run-testing-guide.md")).splitlines())
    assert real_run_lines <= 220


def test_docs_do_not_publish_legacy_runtime_instructions() -> None:
    forbidden = [
        "performer WORKFLOW",
        "WORKFLOW.md --once",
        "--once",
        "--dispatch-issue-id",
        "--advance-request-path",
        "--phase-result-path",
        "phase_runs",
        "runtime_phase",
        "orchestration_runs",
        "performer:phase/",
        "direct polling",
        "direct Performer polling",
        "legacy phase",
        "phase scheduling",
    ]
    docs = list(Path("docs").rglob("*.md")) + ENTRYPOINT_DOCS

    for path in docs:
        text = _read(path)
        for phrase in forbidden:
            assert phrase not in text, f"{path} still publishes {phrase!r}"


def test_linear_projection_uses_durable_comment_ids_not_hidden_markers() -> None:
    text = _read(Path("docs/product/linear-projection.md"))

    assert "attempt_id -> linear_comment_id" in text
    assert "comment_id" in text
    assert "There are no hidden comment markers" in text
    assert "hidden HTML" not in text
    assert "marker-keyed" not in text


def test_pipeline_docs_are_honest_about_verify_isolation() -> None:
    combined = "\n".join(
        _read(path)
        for path in [
            Path("README.md"),
            Path("docs/product/runtime-pipeline.md"),
            Path("docs/product/gates-verification-integration.md"),
        ]
    )

    assert "disposable worktree" in combined
    assert "mutation detection" in combined
    assert "not OS-level read-only enforcement" in combined
    assert "read-only checkout + disposable workspace" not in combined
