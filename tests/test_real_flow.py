from __future__ import annotations

import json
from argparse import Namespace
from datetime import datetime, timezone
from pathlib import Path
import subprocess

import pytest

from tools import real_flow


def test_parser_accepts_batch_phase_and_keeps_legacy_offline_flag() -> None:
    args = real_flow._parser().parse_args(["--phase", "all", "--offline"])

    assert args.phase == "all"
    assert args.offline is True


def test_all_batch_writes_all_phase_reports_with_one_run_id(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("SYMPHONY_E2E_CODEX_HOME_SEED", str(tmp_path / "seed"))
    monkeypatch.setenv("SYMPHONY_E2E_PROJECT_SLUG", "fixture-project")
    seed = tmp_path / "seed"
    seed.mkdir()
    (seed / "config.toml").write_text('model = "gpt-5.4"\n', encoding="utf-8")

    out = tmp_path / "batch-report.json"
    exit_code = real_flow.run(
        Namespace(
            phase="all",
            project_slug="fixture-project",
            out=out,
            timeout=0.01,
            offline=True,
        )
    )

    assert exit_code == 2
    batch = json.loads(out.read_text(encoding="utf-8"))
    assert batch["phase"] == "batch"
    assert batch["status"] == "failed"
    assert [phase["phase"] for phase in batch["phases"]] == [
        "oauth",
        "linear",
        "performer",
        "overall",
    ]
    run_ids = {phase["run_id"] for phase in batch["phases"]}
    assert len(run_ids) == 1
    artifact_root = Path(batch["artifact_root"])
    assert artifact_root.is_dir()
    for phase in ("oauth", "linear", "performer", "overall"):
        report_path = artifact_root / phase / "report.json"
        assert report_path.is_file()
        assert json.loads(report_path.read_text(encoding="utf-8"))["run_id"] in run_ids


def test_all_batch_continues_after_phase_failure(monkeypatch, tmp_path: Path) -> None:
    calls: list[str] = []

    def phase(name: str):
        def run_phase(context):
            calls.append(name)
            return real_flow._phase_report(
                context,
                name,
                "failed" if name == "oauth" else "passed",
                checks=({"name": f"{name}_diagnostic", "passed": True, "required": True, "observations": {}},)
                if name != "oauth"
                else (),
                failures=(
                    real_flow._failure(
                        "auth",
                        "oauth_browser_session_unavailable",
                        "signed-in browser session unavailable",
                        next_action="reuse_existing_browser_session",
                    ),
                )
                if name == "oauth"
                else (),
            )

        return run_phase

    monkeypatch.setattr(real_flow, "_run_oauth_phase", phase("oauth"))
    monkeypatch.setattr(real_flow, "_run_linear_phase", phase("linear"))
    monkeypatch.setattr(real_flow, "_run_performer_phase", phase("performer"))
    monkeypatch.setenv("SYMPHONY_E2E_CODEX_HOME_SEED", str(tmp_path / "seed"))

    out = tmp_path / "batch-report.json"
    exit_code = real_flow.run(
        Namespace(
            phase="all",
            project_slug="fixture-project",
            out=out,
            timeout=0.01,
            offline=False,
        )
    )

    assert exit_code == 2
    assert calls == ["oauth", "linear", "performer"]
    batch = json.loads(out.read_text(encoding="utf-8"))
    assert batch["phases"][-1]["status"] == "skipped"
    assert batch["phases"][-1]["blocked_by"] == ["oauth"]


def test_sanitize_value_redacts_secret_values_and_auth_paths() -> None:
    value = {
        "token": "generic-secret-value",
        "token_present": True,
        "nested": ["Authorization: Bearer abcdefghijklmnop", "token=generic-secret-value", "/tmp/auth.json"],
        "safe": "linear_request_failed:http_401",
    }

    sanitized = real_flow._sanitize_value(value)

    assert sanitized["token"] == "[REDACTED]"
    assert sanitized["token_present"] is True
    assert sanitized["nested"][0] == "Authorization: Bearer [REDACTED]"
    assert sanitized["nested"][1] == "token=[REDACTED]"
    assert sanitized["nested"][2] == "[REDACTED_PATH]"
    assert sanitized["safe"] == value["safe"]


def test_select_backlog_state_uses_single_backlog_or_unstarted_fallback() -> None:
    assert real_flow._select_backlog_state(
        [
            {"id": "backlog", "type": "backlog"},
            {"id": "todo", "type": "unstarted"},
        ]
    )["id"] == "backlog"
    assert real_flow._select_backlog_state([{"id": "todo", "type": "unstarted"}])["id"] == "todo"


def test_select_backlog_state_rejects_ambiguous_candidates() -> None:
    with pytest.raises(ValueError, match="linear_fixture_state_ambiguous"):
        real_flow._select_backlog_state(
            [
                {"id": "backlog-1", "type": "backlog"},
                {"id": "backlog-2", "type": "backlog"},
            ]
        )


def test_oauth_phase_collects_all_checks_after_unavailable_session(monkeypatch, tmp_path: Path) -> None:
    class FakeObserver:
        def __init__(self, *_args, **_kwargs):
            self.responses = {
                "/api/v1/auth/me": real_flow._HttpObservation(401, {}),
                "/api/v1/linear/installations": real_flow._HttpObservation(401, {}),
                "/api/v1/linear/projects": real_flow._HttpObservation(401, {}),
                "/api/v1/linear/oauth/callback": real_flow._HttpObservation(400, {}),
            }

        def get(self, path: str):
            if "state=" in path:
                return real_flow._HttpObservation(400, {})
            return self.responses[path]

        get_authenticated = get

    monkeypatch.setattr(real_flow, "_PodiumObserver", FakeObserver)
    context = real_flow._RunContext(
        run_id="run-1",
        artifact_root=tmp_path,
        output_path=tmp_path / "report.json",
        project_slug="fixture",
        timeout=1,
        offline=False,
        settings={"podium_url": "http://podium", "project_slug": "fixture", "codex_seed": ""},
    )

    report = real_flow._run_oauth_phase(context)

    assert report["status"] == "failed"
    assert len(report["checks"]) == 7
    assert {check["name"] for check in report["checks"]} >= {
        "oauth_unauthenticated_rejected",
        "oauth_authenticated_session_observed",
        "oauth_active_installation_healthy",
        "oauth_selected_project_visible",
        "oauth_callback_missing_state_rejected",
        "oauth_callback_invalid_state_rejected",
    }


def test_linear_phase_is_independent_from_podium_and_oauth(monkeypatch, tmp_path: Path) -> None:
    class FakeFixture:
        @classmethod
        def from_environment(cls, **_kwargs):
            return cls()

        def graphql(self, _query):
            return {"viewer": {"id": "viewer-1"}}

        def project(self, slug):
            return {"id": "project-1", "name": "Fixture", "slug": slug, "team": {"id": "team-1"}}

        def workflow_states(self, _team_id):
            return [{"id": "state-1", "type": "backlog"}]

        def create_parent_issue(self, *_args, **_kwargs):
            return {"id": "issue-1", "identifier": "SYM-1", "parent": None}

        def issue(self, _issue_id):
            return {"id": "issue-1", "identifier": "SYM-1", "parent": None}

        def children(self, _issue_id):
            return []

    class ForbiddenObserver:
        def __init__(self, *_args, **_kwargs):
            raise AssertionError("Linear phase must not access Podium")

    monkeypatch.setattr(real_flow, "LinearFixture", FakeFixture)
    monkeypatch.setattr(real_flow, "_PodiumObserver", ForbiddenObserver)
    context = real_flow._RunContext(
        run_id="run-linear",
        artifact_root=tmp_path,
        output_path=tmp_path / "report.json",
        project_slug="fixture",
        timeout=1,
        offline=False,
        settings={"project_slug": "fixture", "codex_seed": "", "podium_url": ""},
    )

    report = real_flow._run_linear_phase(context)

    assert report["status"] == "passed"
    assert all(check["name"].startswith("linear_fixture_") for check in report["checks"])


def test_performer_config_is_loaded_only_from_static_seed(tmp_path: Path) -> None:
    seed = tmp_path / "seed"
    seed.mkdir()
    (seed / "config.toml").write_text(
        'model = "gpt-5.4"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncli_auth_credentials_store = "file"\n',
        encoding="utf-8",
    )

    config = real_flow._load_static_performer_config(seed)

    assert 'model = "gpt-5.4"' in config
    assert 'cli_auth_credentials_store = "file"' in config


def test_podium_observer_bounds_external_timeout() -> None:
    assert real_flow._PodiumObserver("http://podium", timeout=600).timeout == 20
    assert real_flow._PodiumObserver("http://podium", timeout=0).timeout == 0.1


def test_authenticated_observer_reads_only_sanitized_browser_observations(tmp_path: Path) -> None:
    observation_path = tmp_path / "browser-observation.json"
    observation_path.write_text(
        json.dumps(
            {
                "base_url": "http://podium",
                "captured_at": datetime.now(timezone.utc).isoformat(),
                "observations": {
                    "/api/v1/auth/me": {"status_code": 200, "payload": {"user": {"id": "user-1", "email": "e@example.test"}}},
                    "/api/v1/managed-runs": {
                        "status_code": 200,
                        "payload": {
                            "conductors": [
                                {"profiles": {"performer": {"performer_kind": "codex"}}}
                            ]
                        },
                    },
                }
            }
        ),
        encoding="utf-8",
    )

    observer = real_flow._PodiumObserver(
        "http://podium", timeout=1, browser_observation=str(observation_path)
    )

    authenticated = observer.get_authenticated("/api/v1/auth/me")
    managed_runs = observer.get_authenticated("/api/v1/managed-runs")

    assert authenticated.status_code == 200
    assert authenticated.payload["user"]["id"] == "user-1"
    assert managed_runs.status_code == 200
    assert managed_runs.payload["conductors"][0]["profiles"]["performer"]["performer_kind"] == "codex"


def test_authenticated_observer_rejects_secret_bearing_browser_observation(tmp_path: Path) -> None:
    observation_path = tmp_path / "browser-observation.json"
    observation_path.write_text(
        json.dumps(
            {
                "base_url": "http://podium",
                "captured_at": datetime.now(timezone.utc).isoformat(),
                "observations": {
                    "/api/v1/auth/me": {
                        "status_code": 200,
                        "payload": {"access_token": "must-not-be-present"},
                    }
                }
            }
        ),
        encoding="utf-8",
    )

    observer = real_flow._PodiumObserver(
        "http://podium", timeout=1, browser_observation=str(observation_path)
    )

    response = observer.get_authenticated("/api/v1/auth/me")

    assert response.status_code == 0
    assert response.error_code == "browser_session_observation_contains_secret"


def test_authenticated_observer_rejects_auth_file_observation_path(tmp_path: Path) -> None:
    auth_path = tmp_path / "auth.json"
    auth_path.write_text("{}", encoding="utf-8")

    observer = real_flow._PodiumObserver("http://podium", timeout=1, browser_observation=str(auth_path))

    response = observer.get_authenticated("/api/v1/auth/me")

    assert response.status_code == 0
    assert response.error_code == "browser_session_observation_path_forbidden"


def test_authenticated_observer_rejects_stale_or_extra_browser_fields(tmp_path: Path) -> None:
    observation_path = tmp_path / "browser-observation.json"
    observation_path.write_text(
        json.dumps(
            {
                "base_url": "http://podium",
                "captured_at": "2020-01-01T00:00:00+00:00",
                "observations": {
                    "/api/v1/auth/me": {
                        "status_code": 200,
                        "headers": {"Authorization": "Bearer secret"},
                        "payload": {},
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    observer = real_flow._PodiumObserver("http://podium", timeout=1, browser_observation=str(observation_path))

    response = observer.get_authenticated("/api/v1/auth/me")

    assert response.error_code == "browser_session_observation_stale"


def test_authenticated_observer_rejects_unknown_payload_keys_and_nested_credentials(tmp_path: Path) -> None:
    observation_path = tmp_path / "browser-observation.json"
    observation_path.write_text(
        json.dumps(
            {
                "base_url": "http://podium",
                "captured_at": datetime.now(timezone.utc).isoformat(),
                "observations": {
                    "/api/v1/auth/me": {
                        "status_code": 200,
                        "payload": {
                            "user": {"id": "user-1", "email": "e@example.test"},
                            "foo": "raw-secret",
                        },
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    observer = real_flow._PodiumObserver("http://podium", timeout=1, browser_observation=str(observation_path))
    response = observer.get_authenticated("/api/v1/auth/me")

    assert response.status_code == 0
    assert response.error_code == "browser_session_observation_invalid:payload_fields"

    observation_path.write_text(
        json.dumps(
            {
                "base_url": "http://podium",
                "captured_at": datetime.now(timezone.utc).isoformat(),
                "observations": {
                    "/api/v1/auth/me": {
                        "status_code": 200,
                        "payload": {"user": {"id": "user-1", "email": "e@example.test", "credential": {"value": "raw-secret"}}},
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    observer = real_flow._PodiumObserver("http://podium", timeout=1, browser_observation=str(observation_path))
    response = observer.get_authenticated("/api/v1/auth/me")
    assert response.error_code == "browser_session_observation_contains_secret"


def test_authenticated_observer_rejects_symlinked_auth_path(tmp_path: Path) -> None:
    auth_path = tmp_path / "auth.json"
    auth_path.write_text("{}", encoding="utf-8")
    observation_path = tmp_path / "observation.json"
    observation_path.symlink_to(auth_path)

    observer = real_flow._PodiumObserver("http://podium", timeout=1, browser_observation=str(observation_path))
    response = observer.get_authenticated("/api/v1/auth/me")

    assert response.status_code == 0
    assert response.error_code == "browser_session_observation_path_forbidden"


def test_performer_phase_fails_closed_when_staged_seed_has_no_auth(tmp_path: Path) -> None:
    seed = tmp_path / "seed"
    seed.mkdir()
    (seed / "config.toml").write_text('model = "gpt-5.4"\n', encoding="utf-8")
    context = real_flow._RunContext(
        run_id="run-performer",
        artifact_root=tmp_path / "artifacts",
        output_path=tmp_path / "report.json",
        project_slug="fixture",
        timeout=0.1,
        offline=False,
        settings={"podium_url": "http://podium", "project_slug": "fixture", "codex_seed": str(seed)},
    )

    report = real_flow._run_performer_phase(context)

    assert report["status"] == "failed"
    assert report["failures"][0]["error_code"] == "staged_codex_seed_incomplete"
    assert str(seed) not in json.dumps(report)


def test_overall_fixtures_have_deterministic_success_rework_and_block_behavior(tmp_path: Path) -> None:
    paths, artifacts = real_flow._prepare_overall_fixtures(tmp_path)

    success = subprocess.run(
        ["python", ".e2e/verify_success.py"], cwd=paths["success"], check=False, capture_output=True, text=True
    )
    first_rework = subprocess.run(
        ["python", ".e2e/verify_once.py"], cwd=paths["rework"], check=False, capture_output=True, text=True
    )
    second_rework = subprocess.run(
        ["python", ".e2e/verify_once.py"], cwd=paths["rework"], check=False, capture_output=True, text=True
    )
    block = subprocess.run(
        ["python", ".e2e/verify_always_fail.py"], cwd=paths["block"], check=False, capture_output=True, text=True
    )

    assert success.returncode == 0
    assert first_rework.returncode == 1
    assert second_rework.returncode == 0
    assert block.returncode == 1
    assert real_flow._fixture_contract_ok(paths)
    assert len(artifacts) == 4


def test_overall_fixture_contract_rejects_tampered_script(tmp_path: Path) -> None:
    paths, _artifacts = real_flow._prepare_overall_fixtures(tmp_path)

    (paths["success"] / ".e2e" / "verify_success.py").write_text("raise SystemExit(1)\n", encoding="utf-8")

    assert real_flow._fixture_contract_ok(paths) is False


def test_overall_fencing_probe_uses_durable_store_boundaries(tmp_path: Path) -> None:
    results, artifacts = real_flow._overall_isolated_fencing_probes(tmp_path)

    assert results == {"duplicate": True, "stale": True}
    assert len(artifacts) == 1
    evidence = json.loads(Path(artifacts[0]).read_text(encoding="utf-8"))
    assert evidence["duplicate"]["gate_evidence_count"] == 1
    assert evidence["stale"]["stale_rejected"] is True


def test_overall_records_each_scenario_when_managed_runs_are_not_authenticated(monkeypatch, tmp_path: Path) -> None:
    class FakeObserver:
        def __init__(self, *_args, **_kwargs):
            pass

        def get(self, _path: str):
            return real_flow._HttpObservation(401, {})

        get_authenticated = get

    monkeypatch.setattr(real_flow, "_PodiumObserver", FakeObserver)
    context = real_flow._RunContext(
        run_id="run-overall",
        artifact_root=tmp_path,
        output_path=tmp_path / "report.json",
        project_slug="fixture",
        timeout=1,
        offline=False,
        settings={"podium_url": "http://podium", "project_slug": "fixture", "codex_seed": ""},
    )
    prerequisites = [
        real_flow._phase_report(context, phase, "passed") for phase in ("oauth", "linear", "performer")
    ]

    report = real_flow._run_overall_phase(context, prerequisites)

    assert report["status"] == "failed"
    assert {check["name"] for check in report["checks"]} == {
        "overall_fixture_plan_contract",
        "overall_success_closure",
        "overall_gate_rework_block",
        "overall_duplicate_result_idempotent",
        "overall_stale_result_rejected",
        "overall_runtime_wait_resumable",
        "overall_redaction_parity",
    }
    assert len(report["artifacts"]) == 4


@pytest.mark.parametrize("phase", ["oauth", "linear", "performer"])
def test_phase_only_reports_are_diagnostic(tmp_path: Path, monkeypatch, phase: str) -> None:
    monkeypatch.setenv("SYMPHONY_E2E_CODEX_HOME_SEED", str(tmp_path / "seed"))
    (tmp_path / "seed").mkdir()
    out = tmp_path / f"{phase}.json"

    exit_code = real_flow.run(
        Namespace(
            phase=phase,
            project_slug="fixture-project",
            out=out,
            timeout=0.01,
            offline=True,
        )
    )

    assert exit_code == 2
    report = json.loads(out.read_text(encoding="utf-8"))
    assert report["phase"] == phase
    assert report["acceptance"] is False


def test_phase_only_diagnostic_does_not_overwrite_existing_batch(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("SYMPHONY_E2E_CODEX_HOME_SEED", str(tmp_path / "seed"))
    (tmp_path / "seed").mkdir()
    out = tmp_path / "batch-report.json"
    original = {"phase": "batch", "run_id": "accepted-run", "status": "passed"}
    out.write_text(json.dumps(original), encoding="utf-8")

    exit_code = real_flow.run(
        Namespace(
            phase="oauth",
            project_slug="fixture-project",
            out=out,
            timeout=0.01,
            offline=True,
        )
    )

    assert exit_code == 2
    assert json.loads(out.read_text(encoding="utf-8")) == original
    diagnostic = tmp_path / "batch-report-oauth-diagnostic.json"
    assert diagnostic.is_file()
    assert json.loads(diagnostic.read_text(encoding="utf-8"))["phase"] == "oauth"
