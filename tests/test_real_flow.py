from __future__ import annotations

import json
import inspect
from argparse import Namespace
from datetime import datetime, timezone
import os
from pathlib import Path
import stat
import subprocess
import sys
import textwrap

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


def test_select_started_state_requires_one_started_state() -> None:
    assert real_flow._select_started_state(
        [{"id": "started", "type": "started"}]
    )["id"] == "started"
    with pytest.raises(ValueError, match="linear_fixture_started_state_ambiguous"):
        real_flow._select_started_state([])


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
            return {
                "id": "project-1",
                "name": "Fixture",
                "slugId": slug,
                "team": {"id": "team-1"},
            }

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
    assert report["observations"]["project"]["slug"] == "fixture"


def test_real_flow_has_no_active_provider_owned_runtime_path() -> None:
    source = "\n".join(
        inspect.getsource(value)
        for value in (
            real_flow._run_performer_phase,
            real_flow._staged_performer_environment,
            real_flow._exchange_control,
            real_flow._run_installed_turn,
        )
    )

    assert "performer_api." + "codex_runtime" not in source
    assert "conductor." + "performer_" + "credentials" not in source
    assert "PerformerCredential" + "Slots" not in source
    assert "validate_codex_toml" not in source
    assert "codex_home=" not in source
    assert "openai_" + "codex" not in source
    assert "from performer " not in source
    assert "import performer" not in source


def test_installed_performer_command_stays_in_the_active_virtualenv(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    interpreter = tmp_path / "python-install" / "python"
    interpreter.parent.mkdir()
    interpreter.write_text("", encoding="utf-8")
    virtualenv_bin = tmp_path / "venv" / "bin"
    virtualenv_bin.mkdir(parents=True)
    virtualenv_python = virtualenv_bin / "python"
    virtualenv_python.symlink_to(interpreter)
    performer = virtualenv_bin / "performer"
    performer.write_text("#!/bin/sh\n", encoding="utf-8")
    performer.chmod(performer.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setattr(real_flow.sys, "executable", str(virtualenv_python))

    assert real_flow._installed_performer_command() == (str(performer),)


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


def _install_real_flow_performer(
    tmp_path: Path,
    journal: Path,
    *,
    check_failure: bool = False,
) -> Path:
    performer = tmp_path / "performer"
    performer.write_text(
        textwrap.dedent(
            f"""\
            #!{sys.executable}
            import json
            import os
            from pathlib import Path
            import struct
            import sys

            journal = Path({str(journal)!r})
            check_failure = {check_failure!r}

            def record(mode):
                with journal.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps({{"mode": mode, "codex_home": os.environ.get("CODEX_HOME", "")}}) + "\\n")
                print("backend_context=" + os.environ.get("CODEX_HOME", ""), file=sys.stderr, flush=True)

            def emit(payload):
                print(json.dumps({{"frame_kind": "control.result", "payload": payload}}, separators=(",", ":")), flush=True)

            if sys.argv[1:] == ["control", "--performer-kind", "codex"]:
                record("control")
                while True:
                    header = sys.stdin.buffer.read(4)
                    if not header:
                        break
                    size = struct.unpack(">I", header)[0]
                    request = json.loads(sys.stdin.buffer.read(size))
                    operation = request["operation"]
                    common = {{
                        "protocol_version": 1,
                        "request_id": request["request_id"],
                        "operation": operation,
                        "status": "succeeded",
                        "capabilities": None,
                        "readiness": None,
                        "account": None,
                        "login": None,
                        "configuration": None,
                        "check": None,
                        "error": None,
                    }}
                    if operation == "performer.status":
                        common.update({{
                            "capabilities": {{
                                "protocol_version": 1,
                                "capability_version": 1,
                                "performer_kind": "codex",
                                "display_name": "Codex",
                                "turn_kinds": ["plan", "execute", "gate"],
                                "login_methods": ["device_code", "api_key"],
                                "supports_session_delete": True,
                                "editable_settings": ["api_base_url"],
                                "config_source_visible": True,
                                "check_supported": True,
                            }},
                            "readiness": {{
                                "performer_kind": "codex",
                                "binding_generation": 1,
                                "capability_version": 1,
                                "execution_policy_sha256": "0" * 64,
                                "status": "unchecked",
                                "last_check_status": "none",
                                "error": None,
                            }},
                            "account": {{"status": "authenticated", "display_label": "E2E"}},
                            "login": {{"status": "idle", "method": None}},
                        }})
                    elif operation == "performer.check":
                        policy_hash = request["arguments"]["execution_policy_sha256"]
                        print(json.dumps({{
                            "frame_kind": "control.event",
                            "payload": {{
                                "protocol_version": 1,
                                "request_id": request["request_id"],
                                "operation": operation,
                                "sequence": 1,
                                "event_kind": "control.heartbeat",
                                "message": "Performer Check is running.",
                                "verification_url": None,
                                "user_code": None,
                                "expires_at": None,
                            }},
                        }}, separators=(",", ":")), flush=True)
                        check_reason = "Codex Check failed: Codex authentication failed." if check_failure else None
                        common.update({{
                            "readiness": {{
                                "performer_kind": "codex",
                                "binding_generation": 1,
                                "capability_version": 1,
                                "execution_policy_sha256": policy_hash,
                                "status": "failed" if check_failure else "ready",
                                "last_check_status": "failed" if check_failure else "passed",
                                "error": {{
                                    "error_code": "performer_check_failed",
                                    "sanitized_reason": check_reason,
                                    "action_required": True,
                                    "retryable": True,
                                    "attempt_number": 1,
                                    "next_action": "Repair Codex authentication and run Check again.",
                                }} if check_failure else None,
                            }},
                            "check": {{
                                "status": "failed" if check_failure else "passed",
                                "started_at": "2026-07-13T00:00:00Z",
                                "finished_at": "2026-07-13T00:00:01Z",
                                "summary": check_reason or "Performer Check passed.",
                            }},
                        }})
                    emit(common)
                raise SystemExit(0)

            request_path = Path(sys.argv[sys.argv.index("--turn-request-path") + 1])
            result_path = Path(sys.argv[sys.argv.index("--turn-result-path") + 1])
            request = json.loads(request_path.read_text(encoding="utf-8"))
            kind = request["context"]["turn_kind"]
            record(kind)
            result = {{
                "protocol_version": 1,
                "context": request["context"],
                "thread_id": "thread-e2e",
                "plan": None,
                "execute_result": None,
                "gate_result": None,
                "runtime_wait": None,
                "events": [],
            }}
            task = {{
                "id": "task-1",
                "title": "Update the diagnostic workspace",
                "objective": "Append the accepted marker to README.md.",
                "acceptance_criteria": ["README.md contains the accepted marker"],
                "verification_commands": ["git diff --check"],
                "files_likely_touched": ["README.md"],
            }}
            if kind == "plan":
                result["plan"] = {{
                    "summary": "Exercise installed Performer turns.",
                    "tasks": [task],
                    "risks": [],
                    "architecture_decisions": [],
                    "open_questions": [],
                    "approval_required": False,
                }}
            elif kind == "execute":
                workspace = Path(request["workspace_path"])
                (workspace / "README.md").write_text("Symphony real E2E disposable workspace.\\naccepted\\n", encoding="utf-8")
                result["execute_result"] = {{
                    "status": "ready_for_gate",
                    "summary": "Updated README.md.",
                    "changed_files": ["README.md"],
                    "acceptance_evidence": [{{
                        "criterion": "README.md contains the accepted marker",
                        "evidence": "README.md was updated",
                        "passed": True,
                    }}],
                    "blocked_reason": None,
                }}
            else:
                result["gate_result"] = {{
                    "passed": True,
                    "score": 4,
                    "threshold": 3,
                    "rubric": {{"correctness": {{"score": 4, "weight": 1}}}},
                    "provenance": [{{"source": "performer", "attempt_id": "gate-1"}}],
                    "findings": ["The diagnostic task passed."],
                    "artifact_refs": ["artifact://run-performer/task-1"],
                }}
            result_path.write_text(json.dumps(result), encoding="utf-8")
            """
        ),
        encoding="utf-8",
    )
    performer.chmod(performer.stat().st_mode | stat.S_IXUSR)
    return performer


def test_performer_phase_uses_one_staged_context_for_installed_control_and_turns(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seed = tmp_path / "seed"
    seed.mkdir()
    for name in ("config.toml", "auth.json", "version.json", "models_cache.json"):
        (seed / name).write_text("{}", encoding="utf-8")
    journal = tmp_path / "performer-journal.jsonl"
    performer = _install_real_flow_performer(tmp_path, journal)
    monkeypatch.setattr(real_flow, "_installed_performer_command", lambda: (str(performer),))
    context = real_flow._RunContext(
        run_id="run-performer",
        artifact_root=tmp_path / "artifacts",
        output_path=tmp_path / "report.json",
        project_slug="fixture",
        timeout=5,
        offline=False,
        settings={
            "podium_url": "http://podium",
            "project_slug": "fixture",
            "codex_seed": str(seed),
        },
    )

    report = real_flow._run_performer_phase(context)

    assert report["status"] == "passed"
    assert all(check["passed"] for check in report["checks"])
    assert {check["name"] for check in report["checks"]} == {
        "performer_control_status",
        "performer_manual_check",
        "performer_plan_turn",
        "performer_execute_turn",
        "performer_gate_turn",
        "performer_artifacts_secret_free",
    }
    calls = [json.loads(line) for line in journal.read_text(encoding="utf-8").splitlines()]
    assert [call["mode"] for call in calls] == ["control", "plan", "execute", "gate"]
    staged_homes = {call["codex_home"] for call in calls}
    assert len(staged_homes) == 1
    assert staged_homes != {str(seed)}
    staged_home = next(iter(staged_homes))
    assert not Path(staged_home).exists()
    for artifact in report["artifacts"]:
        assert staged_home not in Path(artifact).read_text(encoding="utf-8")
    assert not real_flow._artifact_has_secret(report["artifacts"])
    assert report["observations"]["execution_policy_sha256"] == real_flow.canonical_sha256(
        real_flow._REAL_EXECUTION_POLICY
    )
    assert "seed_hash" not in report["observations"]
    assert "config_sha256" not in report["observations"]


def test_performer_phase_fails_closed_when_the_approved_seed_is_missing(tmp_path: Path) -> None:
    context = real_flow._RunContext(
        run_id="run-performer-missing-seed",
        artifact_root=tmp_path / "artifacts",
        output_path=tmp_path / "report.json",
        project_slug="fixture",
        timeout=1,
        offline=False,
        settings={"codex_seed": str(tmp_path / "missing")},
    )

    report = real_flow._run_performer_phase(context)

    assert report["status"] == "failed"
    assert report["failures"][0]["error_code"] == "performer_seed_unavailable"
    assert report["checks"][0]["name"] == "performer_control_status"
    assert report["checks"][0]["passed"] is False


def test_performer_phase_surfaces_safe_check_failure_category(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seed = tmp_path / "seed"
    seed.mkdir()
    for name in ("config.toml", "auth.json"):
        (seed / name).write_text("{}", encoding="utf-8")
    journal = tmp_path / "performer-journal.jsonl"
    performer = _install_real_flow_performer(
        tmp_path,
        journal,
        check_failure=True,
    )
    monkeypatch.setattr(real_flow, "_installed_performer_command", lambda: (str(performer),))
    context = real_flow._RunContext(
        run_id="run-check-failure",
        artifact_root=tmp_path / "artifacts",
        output_path=tmp_path / "report.json",
        project_slug="fixture",
        timeout=5,
        offline=False,
        settings={"codex_seed": str(seed)},
    )

    report = real_flow._run_performer_phase(context)

    assert report["failures"][0]["error_code"] == "performer_check_failed"
    assert report["failures"][0]["sanitized_reason"] == (
        "The installed Performer manual Check failed: "
        "Codex Check failed: Codex authentication failed."
    )


def test_performer_workspace_verification_observes_readme_changes(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    real_flow._git_workspace(workspace)

    (workspace / "README.md").write_text("trailing whitespace  \n", encoding="utf-8")

    verification = subprocess.run(
        ["git", "-C", str(workspace), "diff", "--check"],
        check=False,
        capture_output=True,
        text=True,
    )
    assert verification.returncode != 0


def test_performer_phase_preserves_primary_failure_when_control_cleanup_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seed = tmp_path / "seed"
    seed.mkdir()
    for name in ("config.toml", "auth.json"):
        (seed / name).write_text("{}", encoding="utf-8")

    class FailedProcess:
        returncode = 23

    def fail_status(*_args: object, **_kwargs: object) -> None:
        raise real_flow._PerformerDiagnosticError(
            "performer_status_not_ready",
            "The installed Performer status was not ready.",
        )

    monkeypatch.setattr(real_flow, "_git_workspace", lambda path: path.mkdir(parents=True))
    monkeypatch.setattr(real_flow.subprocess, "Popen", lambda *_args, **_kwargs: FailedProcess())
    monkeypatch.setattr(real_flow, "_exchange_control", fail_status)
    monkeypatch.setattr(real_flow, "_stop_control_process", lambda _process: b"")
    context = real_flow._RunContext(
        run_id="run-primary-failure",
        artifact_root=tmp_path / "artifacts",
        output_path=tmp_path / "report.json",
        project_slug="fixture",
        timeout=1,
        offline=False,
        settings={"codex_seed": str(seed)},
    )

    report = real_flow._run_performer_phase(context)

    assert report["failures"][0]["error_code"] == "performer_status_not_ready"


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


def test_overall_materialization_ignores_runtime_fixture_state(tmp_path: Path) -> None:
    fixture_paths, _artifacts = real_flow._prepare_overall_fixtures(tmp_path / "artifacts")
    repository = tmp_path / "repository"
    real_flow._git_workspace(repository)
    context = real_flow._RunContext(
        run_id="run-materialize",
        artifact_root=tmp_path / "artifacts",
        output_path=tmp_path / "report.json",
        project_slug="fixture",
        timeout=1,
        offline=False,
        settings={"fixture_repository": str(repository)},
    )

    passed, path, error_code = real_flow._materialize_fixture_repository(
        context,
        fixture_paths,
    )

    assert passed is True
    assert path == str(repository.resolve())
    assert error_code == ""
    assert (repository / ".e2e" / ".gitignore").read_text(encoding="utf-8") == (
        "state/\ninput-approved\n"
    )


def test_overall_validates_the_committed_plan_against_the_scenario_contract() -> None:
    run = {
        "plan": {
            "tasks": [
                {
                    "verification_commands": ["python .e2e/verify_success.py"],
                    "files_likely_touched": [".e2e/verify_success.py"],
                }
            ]
        }
    }

    assert real_flow._overall_plan_contract_ok("success", run) is True
    run["plan"]["tasks"][0]["verification_commands"] = ["true"]
    assert real_flow._overall_plan_contract_ok("success", run) is False


def test_overall_success_reads_nested_linear_state_names() -> None:
    run = {"state": "done", "tasks": [{"state": "done"}]}

    assert real_flow._overall_scenario_passed(
        "success",
        run,
        [],
        {"state": {"name": "Done"}},
        [{"state": {"name": "Completed"}}],
    ) is True


def test_overall_conductor_poll_uses_the_requested_timeout(monkeypatch) -> None:
    clock = {"now": 0.0}

    class Observer:
        def get(self, _path: str):
            state = "done" if clock["now"] >= 61.0 else "executing"
            return real_flow._HttpObservation(
                200,
                {
                    "managed_runs": {
                        "runs": [
                            {
                                "parent_issue_id": "parent-1",
                                "run_id": "run-1",
                                "state": state,
                                "tasks": [],
                            }
                        ]
                    }
                },
            )

    monkeypatch.setattr(real_flow.time, "monotonic", lambda: clock["now"])
    monkeypatch.setattr(
        real_flow.time,
        "sleep",
        lambda seconds: clock.__setitem__("now", clock["now"] + max(seconds, 1.0)),
    )

    run, _history, _latest = real_flow._overall_conductor_run(
        Observer(),
        "parent-1",
        timeout=70,
    )

    assert run["state"] == "done"


def test_overall_resumes_runtime_wait_through_marker_and_linear_reopen(tmp_path: Path) -> None:
    class Fixture:
        transitions: list[tuple[str, str]] = []

        def transition_issue(self, issue_id: str, state_id: str):
            self.transitions.append((issue_id, state_id))
            return {"id": issue_id, "state": {"id": state_id}}

    fixture = Fixture()
    repository = tmp_path / "repo"
    (repository / ".e2e").mkdir(parents=True)
    run = {
        "runtime_waits": [
            {
                "state": "open",
                "linear_issue_id": "wait-1",
                "kind": "tool_input_required",
            }
        ]
    }

    resumed, error_code = real_flow._overall_resume_runtime_wait(
        run,
        fixture,
        repository,
        {"id": "state-started"},
    )

    assert resumed is True
    assert error_code == ""
    assert (repository / ".e2e" / "input-approved").read_text(encoding="utf-8") == "approved\n"
    assert fixture.transitions == [("wait-1", "state-started")]


def test_overall_requires_matching_ready_conductor_binding(tmp_path: Path) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()

    class Observer:
        def get(self, path: str):
            if path == "/api/instances":
                return real_flow._HttpObservation(
                    200,
                    {
                        "instances": [
                            {
                                "id": "instance-1",
                                "linear_project": "fixture",
                                "workspace_root": str(repository),
                                "process_status": "running",
                            }
                        ]
                    },
                )
            return real_flow._HttpObservation(
                200,
                {
                    "performer_control": {
                        "status": "ready",
                        "last_check_status": "passed",
                        "execution_policy_sha256": "a" * 64,
                    }
                },
            )

    context = real_flow._RunContext(
        run_id="run-binding",
        artifact_root=tmp_path / "artifacts",
        output_path=tmp_path / "report.json",
        project_slug="fixture",
        timeout=1,
        offline=False,
        settings={"fixture_repository": str(repository)},
    )

    passed, observation = real_flow._overall_conductor_binding_ready(
        Observer(),
        context,
        "a" * 64,
    )

    assert passed is True
    assert observation["instance_id"] == "instance-1"


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
    passing_check = {"name": "required", "passed": True, "required": True}
    prerequisites = [
        real_flow._phase_report(
            context,
            "oauth",
            "passed",
            checks=(passing_check,),
            observations={"selected_project": {"id": "project-1", "slug": "fixture"}},
        ),
        real_flow._phase_report(
            context,
            "linear",
            "passed",
            checks=(passing_check,),
            observations={"project": {"id": "project-1", "slug": "fixture"}},
        ),
        real_flow._phase_report(
            context,
            "performer",
            "passed",
            checks=(passing_check,),
            observations={"execution_policy_sha256": "a" * 64},
        ),
    ]

    report = real_flow._run_overall_phase(context, prerequisites)

    assert report["status"] == "failed"
    assert {check["name"] for check in report["checks"]} == {
        "overall_fixture_plan_contract",
        "overall_conductor_binding_ready",
        "overall_success_closure",
        "overall_gate_rework_block",
        "overall_duplicate_result_idempotent",
        "overall_stale_result_rejected",
        "overall_runtime_wait_resumable",
        "overall_redaction_parity",
    }
    assert len(report["artifacts"]) == 5
    assert any(
        Path(artifact).name == "evidence.json"
        and Path(artifact).parent.name == "fencing-probes"
        for artifact in report["artifacts"]
    )


def test_overall_rejects_prerequisites_for_different_projects(tmp_path: Path) -> None:
    context = real_flow._RunContext(
        run_id="run-project-mismatch",
        artifact_root=tmp_path,
        output_path=tmp_path / "report.json",
        project_slug="fixture",
        timeout=1,
        offline=False,
        settings={"podium_url": "http://podium"},
    )
    passing_check = {"name": "required", "passed": True, "required": True}
    prerequisites = [
        real_flow._phase_report(
            context,
            "oauth",
            "passed",
            checks=(passing_check,),
            observations={"selected_project": {"id": "project-1", "slug": "fixture"}},
        ),
        real_flow._phase_report(
            context,
            "linear",
            "passed",
            checks=(passing_check,),
            observations={"project": {"id": "project-2", "slug": "fixture"}},
        ),
        real_flow._phase_report(
            context,
            "performer",
            "passed",
            checks=(passing_check,),
            observations={"execution_policy_sha256": "a" * 64},
        ),
    ]

    report = real_flow._run_overall_phase(context, prerequisites)

    assert report["status"] == "skipped"
    assert report["blocked_by"] == ["project_identity"]


def test_overall_rejects_passed_prerequisites_without_identity_evidence(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakeObserver:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        def get_authenticated(self, _path: str) -> real_flow._HttpObservation:
            return real_flow._HttpObservation(401, {})

    monkeypatch.setattr(real_flow, "_PodiumObserver", FakeObserver)
    context = real_flow._RunContext(
        run_id="run-missing-identity",
        artifact_root=tmp_path,
        output_path=tmp_path / "report.json",
        project_slug="fixture",
        timeout=1,
        offline=False,
        settings={"podium_url": "http://podium"},
    )
    prerequisites = [
        real_flow._phase_report(context, phase, "passed")
        for phase in ("oauth", "linear", "performer")
    ]

    report = real_flow._run_overall_phase(context, prerequisites)

    assert report["status"] == "skipped"
    assert report["blocked_by"] == [
        "project_identity",
        "execution_policy_identity",
    ]


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
