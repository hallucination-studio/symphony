from __future__ import annotations

from pathlib import Path
import re


PRODUCT_DOCS = {
    "README.md",
    "product-shape.md",
    "runtime-pipeline.md",
    "pipeline-state.md",
    "gates-verification-integration.md",
    "linear-projection.md",
    "runtime-profiles-backends.md",
    "linear-native-managed-runs.md",
    "managed-runs-acceptance-matrix.md",
    "acceptance-catalog.md",
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

LINEAR_INSTALLATION_ADR = Path(
    "docs/decisions/0001-linear-installations-and-single-project-conductors.md"
)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _prose(path: Path) -> str:
    return " ".join(_read(path).split())


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


def test_linear_installation_adr_is_linked_and_source_grounded() -> None:
    assert LINEAR_INSTALLATION_ADR.exists()
    readme = _read(Path("docs/product/README.md"))
    decision = _read(LINEAR_INSTALLATION_ADR)

    assert f"../decisions/{LINEAR_INSTALLATION_ADR.name}" in readme
    for source in [
        "https://linear.app/developers/oauth-actor-authorization",
        "https://linear.app/developers/oauth-2-0-authentication",
        "https://linear.app/developers/agents",
    ]:
        assert source in decision


def test_linear_apps_share_one_versioned_oauth_lifecycle() -> None:
    text = _prose(Path("docs/product/linear-integration.md"))

    for phrase in [
        "one default Linear OAuth application",
        "customer-owned application",
        "only its client id and client secret",
        "one versioned OAuth installation lifecycle",
        "https://<podium-host>/api/v1/linear/oauth/callback",
        "Podium does not accept an operator-supplied callback URL",
        "actor=app",
        "exact required scopes are `read`, `write`, and `app:assignable`",
        "one-time, short-lived OAuth state",
        "`S256` PKCE",
        "configuration-stale",
        "`303 See Other`",
        "`/setup/linear`",
        "denied consent",
        "valid access token and refresh metadata",
        "viewer.app=true",
        "real Linear organization id",
        "workspace-specific app user id",
        "project discovery and access",
        "First installation activates immediately",
        "same application, organization, and app-user identity",
        "atomically rotates credentials without draining",
        "Different app identity",
        "A failed candidate never replaces the active installation",
        "prepares every bound Conductor",
        "switches atomically",
        "Different Linear organization",
        "explicit reset or migration",
        "There is no global application-id/token fallback",
    ]:
        assert phrase in text


def test_linear_token_lifecycle_is_refreshable_and_fail_closed() -> None:
    text = _prose(Path("docs/product/linear-integration.md"))

    for phrase in [
        "access tokens expire after 24 hours",
        "refresh tokens rotate",
        "central token service",
        "proactive refresh",
        "per-installation single-flight lock",
        "one refresh-and-retry after a Linear `401`",
        "atomically persists the new access token and rotated refresh token",
        "`reauthorization_required`",
        "revokes credentials on disconnect or retirement",
    ]:
        assert phrase in text


def test_linear_project_scope_is_not_project_membership() -> None:
    text = _prose(Path("docs/product/linear-integration.md"))

    assert "does not mutate `ProjectUpdateInput.memberIds`" in text
    assert "Each selected project may have at most one active Conductor" in text
    assert "Each Conductor may bind exactly one selected project" in text
    assert "one repository mapping" in text
    assert "Multiple independent Conductors may run on the same host" in text
    assert "Labels are never dispatch filters" in text


def test_linear_intake_is_reliable_polling_only() -> None:
    text = _prose(Path("docs/product/linear-integration.md"))

    for phrase in [
        "Reliable polling is the only delegated-issue intake path",
        "full cursor pagination",
        "full baseline scan",
        "Incremental scans include delegated and no-longer-delegated issues",
        "`(updatedAt, issue_id)`",
        "transactional page checkpoint",
        "high-water mark advances only after the final page commits",
        "durable exponential backoff",
        "continuously observed delegation epoch",
        "durably observed non-delegated transition",
        "one dispatch per delegation epoch",
        "one durable Managed Run",
    ]:
        assert phrase in text


def test_linear_project_discovery_is_fully_paginated() -> None:
    text = _prose(Path("docs/product/linear-integration.md"))

    assert "Project discovery follows `pageInfo.hasNextPage` and `endCursor`" in text
    assert "never truncates a workspace at a fixed first page" in text


def test_linear_removed_paths_are_absent_from_documentation() -> None:
    forbidden = [
        "webhook",
        "AgentSession",
        "supportsAgentSessions",
        "app:mentionable",
    ]
    docs = list(Path("docs").rglob("*.md")) + ENTRYPOINT_DOCS + [
        Path("deploy/podium-test/README.md")
    ]

    for path in docs:
        text = _read(path).lower()
        for phrase in forbidden:
            assert phrase.lower() not in text, f"{path} still publishes {phrase!r}"


def test_real_acceptance_covers_installation_and_project_binding() -> None:
    text = _prose(Path("docs/real-run-testing-guide.md"))

    for phrase in [
        "complete OAuth as a Linear workspace admin",
        "callback acceptance records the real organization",
        "returns `303 See Other` to `/setup/linear`",
        "denied consent",
        "without changing `ProjectUpdateInput.memberIds`",
        "duplicate project or second project binding is rejected",
        "symphony:conductor/<Name>-<public-id>",
        "full baseline and incremental polling",
        "without duplicate dispatch or skipped issue",
        "same-identity reauthorization",
        "authorize a second test app",
        "old installation remains active",
        "organization mismatch requires explicit reset or migration",
    ]:
        assert phrase in text


def test_podium_web_application_choice_is_explicit_and_clean() -> None:
    text = _prose(Path("docs/product/podium-web.md"))

    for phrase in [
        "Default application is selected initially",
        "does not render customer-owned application fields",
        "Bring your own application",
        "client id and client secret fields",
        "Podium-owned callback URL",
        "There is no callback URL input",
        "returns `303 See Other` to `/setup/linear`",
        "denied consent",
    ]:
        assert phrase in text


def test_conductor_label_and_naming_contract_is_explicit() -> None:
    text = _prose(Path("docs/product/runtime-installation.md"))

    for phrase in [
        "immutable six-character non-secret public id",
        "single ASCII word of at most 16 characters",
        "historical musician surname",
        "shortest available numeric suffix",
        "symphony:conductor/Beethoven-k7m3p2",
        "never routing truth",
    ]:
        assert phrase in text


def test_docs_do_not_publish_removed_linear_installation_paths() -> None:
    forbidden = [
        "PODIUM_LINEAR_APPLICATION_ID",
        "PODIUM_LINEAR_APP_ACCESS_TOKEN",
        "No customer-created Linear OAuth application",
        "multiple Performer instances",
        "event-driven, not polling",
        "delegate poller",
    ]
    docs = list(Path("docs").rglob("*.md")) + ENTRYPOINT_DOCS

    for path in docs:
        text = _read(path)
        for phrase in forbidden:
            assert phrase not in text, f"{path} still publishes {phrase!r}"


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


def test_managed_runs_acceptance_matrix_maps_design_to_blocking_tests() -> None:
    text = _read(Path("docs/product/managed-runs-acceptance-matrix.md"))

    for phrase in [
        "linear-native-managed-runs.md",
        "linear-projection.md",
        "gates-verification-integration.md",
        "test_projection_sync_success_marks_managed_run_projection_healthy",
        "test_managed_run_projector_projects_attempt_comment_by_durable_comment_id",
        "test_managed_run_driver_blocks_when_independent_green_command_fails",
        "external_service_unavailable",
    ]:
        assert phrase in text


def test_managed_runs_acceptance_matrix_references_real_tests() -> None:
    text = _read(Path("docs/product/managed-runs-acceptance-matrix.md"))
    referenced = set(re.findall(r"`(test_[a-zA-Z0-9_]+)`", text))
    test_sources = "\n".join(_read(path) for path in Path("tests").glob("test_*.py"))

    assert referenced
    for test_name in referenced:
        assert re.search(rf"^(async\s+)?def {re.escape(test_name)}\(", test_sources, re.MULTILINE), test_name


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
