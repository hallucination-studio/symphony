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
