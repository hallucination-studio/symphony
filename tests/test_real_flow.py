from __future__ import annotations

import json
from argparse import Namespace
from pathlib import Path

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
        "token": "lin_oauth_very-secret-value",
        "nested": ["Authorization: Bearer abcdefghijklmnop", "/tmp/auth.json"],
        "safe": "linear_request_failed:http_401",
    }

    sanitized = real_flow._sanitize_value(value)

    assert sanitized["token"] == "[REDACTED]"
    assert sanitized["nested"][0] == "Authorization: Bearer [REDACTED]"
    assert sanitized["nested"][1] == "[REDACTED_PATH]"
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
                "/api/v1/runtimes": real_flow._HttpObservation(401, {}),
                "/api/v1/linear/oauth/callback": real_flow._HttpObservation(400, {}),
            }

        def get(self, path: str):
            if "state=" in path:
                return real_flow._HttpObservation(400, {})
            return self.responses[path]

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
    assert len(report["checks"]) == 8
    assert {check["name"] for check in report["checks"]} >= {
        "oauth_unauthenticated_rejected",
        "oauth_authenticated_session_observed",
        "oauth_active_installation_healthy",
        "oauth_selected_project_visible",
        "oauth_existing_runtime_enrolled",
        "oauth_callback_missing_state_rejected",
        "oauth_callback_invalid_state_rejected",
    }


def test_podium_observer_bounds_external_timeout() -> None:
    assert real_flow._PodiumObserver("http://podium", timeout=600).timeout == 20
    assert real_flow._PodiumObserver("http://podium", timeout=0).timeout == 0.1


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
