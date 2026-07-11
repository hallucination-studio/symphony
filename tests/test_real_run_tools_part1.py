from test_real_run_tools_support import *  # noqa: F401,F403
import hashlib
import shutil
import sqlite3
import subprocess


def _managed_turn_fixture(
    run_id: str,
    attempt_id: str = "plan-1",
    *,
    kind: str = "plan",
    work_item_id: str = "",
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    context = {
        "run_id": run_id,
        "work_item_id": work_item_id,
        "policy_revision": 1,
        "plan_version": 0,
        "lease_id": f"lease-{attempt_id}",
        "fencing_token": f"fence-{attempt_id}",
        "turn_id": attempt_id,
    }
    attempt = {
        "attempt_id": attempt_id,
        "kind": kind,
        "mode": "execute" if kind == "work_item" else kind,
        "state": "succeeded",
        "turn_context": context,
    }
    request = {"turn_kind": kind, "workspace_path": "/tmp/workspace", "context": context}
    result = {"turn_kind": kind, "context": context, "plan": {}} if kind == "plan" else {"turn_kind": kind, "context": context, "result": {}}
    return attempt, request, result


def _write_managed_turn_artifacts(instance_root: Path, attempt: dict[str, Any], request: dict[str, Any], result: dict[str, Any]) -> None:
    attempt_id = str(attempt["attempt_id"])
    context = attempt["turn_context"]
    generation_log = instance_root / "logs" / "performer-000001.log"
    generation_log.parent.mkdir(parents=True, exist_ok=True)
    generation_log.write_text(
        f"event=managed_run_turn_started run_id={context['run_id']} attempt_id={attempt_id} "
        f"lease_id={context['lease_id']} fencing_token={context['fencing_token']}\n",
        encoding="utf-8",
    )
    attempt_root = instance_root / "state" / "managed_run" / attempt_id
    attempt_root.mkdir(parents=True, exist_ok=True)
    (attempt_root / "turn-request.json").write_text(json.dumps(request), encoding="utf-8")
    (attempt_root / "turn-result.json").write_text(json.dumps(result), encoding="utf-8")
    (attempt_root / "attempt.log").write_text(
        f"event=performer_stream attempt_id={attempt_id} lease_id={context['lease_id']}\n",
        encoding="utf-8",
    )


def test_runtime_claims_audit_rejects_missing_managed_run_db(tmp_path: Path) -> None:
    tool = load_tool("runtime_claims_audit")

    result = tool.audit_managed_run_db(tmp_path / "missing.db", instance_id="inst-1")

    assert result["pass"] is False
    assert "managed_run_db_missing" in result["failures"]


def test_runtime_claims_audit_reads_authoritative_managed_run_db(tmp_path: Path) -> None:
    tool = load_tool("runtime_claims_audit")
    from conductor.conductor_managed_run_store import ConductorManagedRunStore

    store = ConductorManagedRunStore(tmp_path / "managed_run")
    accepted = store.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1", "issue_title": "Evidence"},
        instance_id="inst-1",
    )
    result = tool.audit_managed_run_db(store.db_path, instance_id="inst-1")

    assert result["pass"] is True
    assert result["counts"]["runs"] == 1
    assert result["runs"] == [
        {
            "run_id": accepted.run_id,
            "issue_identifier": "HELL-1",
            "instance_id": "inst-1",
            "state": "queued",
            "plan_version": 0,
            "latest_reason": "",
        }
    ]


def test_runtime_claims_audit_sanitizes_durable_failure_reason(tmp_path: Path) -> None:
    tool = load_tool("runtime_claims_audit")
    from conductor.conductor_managed_run_state import ManagedRunState
    from conductor.conductor_managed_run_store import ConductorManagedRunStore

    store = ConductorManagedRunStore(tmp_path / "managed_run")
    accepted = store.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1"},
        instance_id="inst-1",
    )
    store.update_run_state(accepted.run_id, ManagedRunState.FAILED, reason="token=secret-value backend setup failed")

    result = tool.audit_managed_run_db(store.db_path, instance_id="inst-1")
    rendered = json.dumps(result, sort_keys=True)

    assert result["pass"] is True
    assert "secret-value" not in rendered
    assert "token=[REDACTED]" in rendered


def test_runtime_claims_audit_requires_artifacts_for_each_durable_attempt(tmp_path: Path) -> None:
    tool = load_tool("runtime_claims_audit")
    from conductor.conductor_managed_run_store import ConductorManagedRunStore

    data_root = tmp_path / "data"
    store = ConductorManagedRunStore(data_root / "managed_run")
    accepted = store.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1"},
        instance_id="inst-1",
    )
    plan_attempt, plan_request, plan_result = _managed_turn_fixture(accepted.run_id)
    store.merge_run_payload(
        accepted.run_id,
        {
            "completed_attempts": [
                plan_attempt,
                {"attempt_id": "execute-1", "state": "succeeded"},
                {"attempt_id": "verify-1", "state": "succeeded"},
            ]
        },
    )
    instance_root = data_root / "instances" / "inst-1"
    _write_managed_turn_artifacts(instance_root, plan_attempt, plan_request, plan_result)
    execute_root = instance_root / "state" / "managed_run" / "execute-1"
    execute_root.mkdir(parents=True)
    (execute_root / "attempt.log").write_text("event=performer_stream\n", encoding="utf-8")

    result = tool.audit_runtime_evidence(data_root, instance_id="inst-1")

    assert result["pass"] is False
    assert {
        "turn_request_missing:execute-1",
        "turn_result_missing:execute-1",
        "attempt_artifacts_missing:verify-1",
    } <= set(result["failures"])


def test_runtime_claims_audit_rejects_empty_attempt_artifacts(tmp_path: Path) -> None:
    tool = load_tool("runtime_claims_audit")
    from conductor.conductor_managed_run_store import ConductorManagedRunStore

    data_root = tmp_path / "data"
    store = ConductorManagedRunStore(data_root / "managed_run")
    accepted = store.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1"},
        instance_id="inst-1",
    )
    attempt, _request, _result = _managed_turn_fixture(accepted.run_id)
    store.merge_run_payload(accepted.run_id, {"completed_attempts": [attempt]})
    instance_root = data_root / "instances" / "inst-1"
    for path in (
        instance_root / "logs" / "performer-000001.log",
        instance_root / "state" / "managed_run" / "plan-1" / "turn-request.json",
        instance_root / "state" / "managed_run" / "plan-1" / "turn-result.json",
        instance_root / "state" / "managed_run" / "plan-1" / "attempt.log",
    ):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"")

    result = tool.audit_runtime_evidence(data_root, instance_id="inst-1")

    assert result["pass"] is False
    assert {
        "generation_log_empty:performer-000001.log",
        "turn_request_empty:plan-1",
        "turn_result_empty:plan-1",
        "attempt_log_empty:plan-1",
    } <= set(result["failures"])


def test_runtime_claims_audit_rejects_durable_attempt_without_id(tmp_path: Path) -> None:
    tool = load_tool("runtime_claims_audit")
    from conductor.conductor_managed_run_store import ConductorManagedRunStore

    data_root = tmp_path / "data"
    store = ConductorManagedRunStore(data_root / "managed_run")
    accepted = store.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1"},
        instance_id="inst-1",
    )
    attempt, request, result_payload = _managed_turn_fixture(accepted.run_id)
    store.merge_run_payload(
        accepted.run_id,
        {"completed_attempts": [attempt, {"kind": "plan", "state": "succeeded"}]},
    )
    _write_managed_turn_artifacts(
        data_root / "instances" / "inst-1",
        attempt,
        request,
        result_payload,
    )

    result = tool.audit_runtime_evidence(data_root, instance_id="inst-1")

    assert result["pass"] is False
    assert f"managed_run_attempt_integrity:{accepted.run_id}:completed_attempt_id_missing" in result["failures"]


def test_runtime_claims_audit_validates_local_verify_attempt_without_performer_files(tmp_path: Path) -> None:
    tool = load_tool("runtime_claims_audit")
    from conductor.conductor_managed_run_store import ConductorManagedRunStore

    data_root = tmp_path / "data"
    store = ConductorManagedRunStore(data_root / "managed_run")
    accepted = store.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1"},
        instance_id="inst-1",
    )
    plan, plan_request, plan_result = _managed_turn_fixture(accepted.run_id)
    work, work_request, work_result = _managed_turn_fixture(
        accepted.run_id,
        "work_item-run-1-wi-1-1",
        kind="work_item",
        work_item_id="wi-1",
    )
    verify = {
        "attempt_id": "verify-run-1-wi-1-1",
        "attempt_number": "1",
        "kind": "verify",
        "mode": "verify",
        "work_item_id": "wi-1",
        "state": "succeeded",
        "gate_snapshot_hash": "gate-hash-1",
        "verification_evidence": {"commands": [{"command": "pytest", "passed": True}]},
        "sanitized_error": "",
    }
    store.merge_run_payload(accepted.run_id, {"completed_attempts": [plan, work, verify]})
    instance_root = data_root / "instances" / "inst-1"
    _write_managed_turn_artifacts(instance_root, plan, plan_request, plan_result)
    _write_managed_turn_artifacts(instance_root, work, work_request, work_result)

    result = tool.audit_runtime_evidence(data_root, instance_id="inst-1")

    assert result["pass"] is True
    assert result["counts"]["attempts"] == 3
    assert set(result["attempt_ids"]) == {
        "plan-1",
        "work_item-run-1-wi-1-1",
        "verify-run-1-wi-1-1",
    }


def test_runtime_claims_audit_sanitizes_jsonl_secret_fields(tmp_path: Path) -> None:
    tool = load_tool("runtime_claims_audit")
    source = tmp_path / "runtime-samples.jsonl"
    target = tmp_path / "bundle" / "runtime-samples.jsonl"
    source.write_text('{"event":"sample","token":"secret-value","message":"api_key=other-secret"}\n', encoding="utf-8")

    tool.copy_sanitized_file(source, target)
    rendered = target.read_text(encoding="utf-8")

    assert "secret-value" not in rendered
    assert "other-secret" not in rendered
    assert "[REDACTED]" in rendered

    payload = tool.sanitize_evidence_value({"token_health": "healthy", "access_token": "secret-value"})
    assert payload == {"token_health": "healthy", "access_token": "<redacted>"}


def test_runtime_claims_audit_sanitizes_camel_case_keys_and_complete_cookie_headers() -> None:
    tool = load_tool("runtime_claims_audit")

    payload = tool.sanitize_evidence_value(
        {
            "refreshToken": "refresh-secret",
            "apiKey": "api-secret",
            "fencing_token": "fence-plan-1",
            "token_usage": {"input_tokens": 10, "output_tokens": 5},
            "message": "Cookie: first=abc; second=def",
        }
    )

    assert payload == {
        "refreshToken": "<redacted>",
        "apiKey": "<redacted>",
        "fencing_token": "fence-plan-1",
        "token_usage": {"input_tokens": 10, "output_tokens": 5},
        "message": "Cookie: [REDACTED]",
    }


def test_runtime_claims_audit_sqlite_snapshot_removes_deleted_secret_bytes(tmp_path: Path) -> None:
    tool = load_tool("runtime_claims_audit")
    source = tmp_path / "source.db"
    secret = "deleted-secret-value-" * 100
    with sqlite3.connect(source) as connection:
        connection.execute("PRAGMA secure_delete = OFF")
        connection.execute("CREATE TABLE evidence (value TEXT NOT NULL)")
        connection.execute("INSERT INTO evidence (value) VALUES (?)", (secret,))
        connection.commit()
        connection.execute("DELETE FROM evidence")
        connection.commit()
    assert secret.encode() in source.read_bytes()

    target = tmp_path / "archive" / "managed_run.db"
    tool.snapshot_sqlite(source, target)

    assert secret.encode() not in target.read_bytes()


def test_runtime_claims_audit_cli_writes_failure_and_exits_nonzero_for_missing_db(tmp_path: Path) -> None:
    out = tmp_path / "runtime-audit.json"

    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "tools" / "runtime_claims_audit.py"),
            "--data-root",
            str(tmp_path / "data"),
            "--instance-id",
            "inst-1",
            "--out",
            str(out),
        ],
        text=True,
        capture_output=True,
    )

    assert result.returncode == 1
    assert set(json.loads(out.read_text(encoding="utf-8"))["failures"]) == {
        "managed_run_db_missing",
        "generation_logs_missing",
        "attempt_logs_missing",
        "turn_requests_missing",
        "turn_results_missing",
    }

def test_linear_tree_audit_requires_work_item_contract_projection() -> None:
    tool = load_tool("linear_tree_audit")

    result = tool.audit_tree(
        {
            "id": "business-1",
            "identifier": "HELL-1",
            "title": "Business",
            "description": "",
            "state": {"name": "In Review", "type": "started"},
            "labels": {"nodes": [{"name": "performer:type/task"}]},
            "children": {
                "nodes": [
                    {
                        "id": "node-1",
                        "identifier": "HELL-2",
                        "title": "Work item",
                        "description": "```yaml\nsymphony:\n  graph_id: graph-1\n  node_id: node-1\n```\n",
                        "parent": {"id": "other", "identifier": "HELL-X"},
                        "state": {"name": "Todo", "type": "unstarted"},
                        "labels": {"nodes": [{"name": "symphony:type/work-item"}]},
                        "children": {"nodes": []},
                    },
                ]
            },
            "inverseRelations": {"nodes": [{"id": "rel-1", "type": "blocks"}]},
        }
    )

    assert result["pass"] is False
    assert "managed_run_summary_missing:HELL-1" in result["failures"]
    assert "work_item_parent_mismatch:HELL-2" in result["failures"]
    assert "work_item_objective_missing:HELL-2" in result["failures"]
    assert "work_item_state_missing:HELL-2" in result["failures"]


def test_linear_tree_audit_requires_work_item_state_gate_details() -> None:
    tool = load_tool("linear_tree_audit")

    result = tool.audit_tree(
        {
            "id": "business-1",
            "identifier": "HELL-1",
            "title": "Business",
            "description": "<!-- symphony:run-summary:start -->\n## Symphony Managed Run Summary\n<!-- symphony:run-summary:end -->",
            "state": {"name": "In Progress", "type": "started"},
            "labels": {"nodes": []},
            "children": {
                "nodes": [
                    {
                        "id": "node-1",
                        "identifier": "HELL-2",
                        "title": "Work item",
                        "description": "\n".join(
                            [
                                "Objective: Project one work item",
                                "",
                                "Acceptance Criteria:",
                                "- child issue exists",
                                "",
                                "Likely Files:",
                                "- `packages/conductor/src/conductor/conductor_managed_run_projection.py`",
                                "",
                                "Verification:",
                                "- RED: pytest tests/test_conductor_managed_run_projection.py -q",
                                "- GREEN: pytest tests/test_conductor_managed_run_projection.py -q",
                                "",
                                "Managed Run State:",
                                "- state: in_progress",
                            ]
                        ),
                        "parent": {"id": "business-1", "identifier": "HELL-1"},
                        "state": {"name": "In Progress", "type": "started"},
                        "labels": {"nodes": [{"name": "symphony:type/work-item"}]},
                        "children": {"nodes": []},
                        "inverseRelations": {"nodes": []},
                    },
                ]
            },
            "inverseRelations": {"nodes": []},
        }
    )

    assert result["pass"] is False
    assert "work_item_gate_missing:HELL-2" in result["failures"]


def test_linear_tree_audit_recognizes_managed_run_child_without_label() -> None:
    tool = load_tool("linear_tree_audit")

    result = tool.audit_tree(
        {
            "id": "business-1",
            "identifier": "HELL-1",
            "title": "Business",
            "description": "<!-- symphony:run-summary:start -->\n## Symphony Managed Run Summary\n<!-- symphony:run-summary:end -->",
            "state": {"name": "Done", "type": "completed"},
            "labels": {"nodes": []},
            "children": {
                "nodes": [
                    {
                        "id": "node-1",
                        "identifier": "HELL-2",
                        "title": "Work item",
                        "description": "\n".join(
                            [
                                "Objective: Project one work item",
                                "",
                                "Acceptance Criteria:",
                                "- child issue exists",
                                "",
                                "Likely Files:",
                                "- `SYMPHONY_REAL_E2E_RESULT.md`",
                                "",
                                "Verification:",
                                "- RED: test -f SYMPHONY_REAL_E2E_RESULT.md",
                                "- GREEN: test -f SYMPHONY_REAL_E2E_RESULT.md",
                                "",
                                "Managed Run State:",
                                "- state: done",
                                "- gate: verification passed",
                            ]
                        ),
                        "parent": {"id": "business-1", "identifier": "HELL-1"},
                        "state": {"name": "Done", "type": "completed"},
                        "labels": {"nodes": []},
                        "children": {"nodes": []},
                        "inverseRelations": {"nodes": []},
                    },
                ]
            },
            "inverseRelations": {"nodes": []},
        }
    )

    assert result["pass"] is True
    assert result["work_item_count"] == 1
    assert result["work_items"][0]["identifier"] == "HELL-2"


def test_linear_tree_audit_requires_exact_work_item_ids_and_dependency_relations() -> None:
    tool = load_tool("linear_tree_audit")
    description = "\n".join(
        [
            "Managed Run Type: work-item",
            "Managed Run Work Item: wi-1",
            "",
            "Objective: Project one work item",
            "",
            "Acceptance Criteria:",
            "- child issue exists",
            "",
            "Likely Files:",
            "- `result.txt`",
            "",
            "Verification:",
            "- RED: test -f result.txt",
            "- GREEN: test -f result.txt",
            "",
            "Managed Run State:",
            "- state: done",
            "- gate: verification passed",
        ]
    )
    tree = {
        "id": "business-1",
        "identifier": "HELL-1",
        "description": "<!-- symphony:run-summary:start -->",
        "state": {"name": "Done", "type": "completed"},
        "labels": {"nodes": []},
        "children": {
            "nodes": [
                {
                    "id": "child-1",
                    "identifier": "HELL-2",
                    "title": "First work item",
                    "description": description,
                    "parent": {"id": "business-1", "identifier": "HELL-1"},
                    "state": {"name": "Done", "type": "completed"},
                    "labels": {"nodes": []},
                    "children": {"nodes": []},
                    "inverseRelations": {"nodes": []},
                }
            ]
        },
        "inverseRelations": {"nodes": []},
    }

    result = tool.audit_tree(
        tree,
        expected_work_item_ids=["wi-1", "wi-2"],
        expected_dependencies={"wi-2": ["wi-1"]},
    )

    assert result["pass"] is False
    assert "work_item_count_mismatch:expected_2:actual_1" in result["failures"]
    assert "work_item_projection_missing:wi-2" in result["failures"]
    assert "work_item_dependency_projection_missing:wi-1->wi-2" in result["failures"]


def test_linear_tree_audit_summarizes_children_and_blocks_relations() -> None:
    tool = load_tool("linear_tree_audit")

    result = tool.summarize_tree(
        {
            "id": "parent-1",
            "identifier": "HELL-1",
            "title": "Parent",
            "state": {"name": "Todo", "type": "unstarted"},
            "labels": {"nodes": []},
            "children": {
                "nodes": [
                    {
                        "id": "child-a",
                        "identifier": "HELL-2",
                        "title": "Child A",
                        "parent": {"id": "parent-1", "identifier": "HELL-1"},
                        "state": {"name": "Done", "type": "completed"},
                        "labels": {"nodes": []},
                        "children": {"nodes": []},
                    },
                    {
                        "id": "child-c",
                        "identifier": "HELL-3",
                        "title": "Child C",
                        "parent": {"id": "parent-1", "identifier": "HELL-1"},
                        "state": {"name": "Todo", "type": "unstarted"},
                        "labels": {"nodes": []},
                        "children": {"nodes": []},
                        "inverseRelations": {
                            "nodes": [
                                {
                                    "id": "rel-1",
                                    "type": "blocks",
                                    "issue": {"id": "child-a", "identifier": "HELL-2", "title": "Child A"},
                                    "relatedIssue": {"id": "child-c", "identifier": "HELL-3", "title": "Child C"},
                                }
                            ]
                        },
                    },
                ]
            },
            "inverseRelations": {"nodes": []},
        }
    )

    assert result["business_issue"]["id"] == "parent-1"
    assert [child["id"] for child in result["children"]] == ["child-a", "child-c"]
    assert result["blocks_relations"] == [
        {
            "id": "rel-1",
            "type": "blocks",
            "issue": {"id": "child-a", "identifier": "HELL-2", "title": "Child A"},
            "relatedIssue": {"id": "child-c", "identifier": "HELL-3", "title": "Child C"},
            "scope": "child",
        }
    ]


@pytest.mark.asyncio
async def test_real_e2e_linear_project_lookup_falls_back_from_slug_to_name(monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e_linear")
    calls: list[dict[str, object]] = []

    async def fake_graphql(token: str, query: str, variables: dict[str, object]) -> dict[str, object]:
        calls.append({"query": query, "variables": variables})
        if "filter: { slugId" in query:
            return {"projects": {"nodes": []}}
        return {
            "projects": {
                "nodes": [
                    {
                        "id": "project-1",
                        "name": "HELL",
                        "slugId": "8ab43179fb54",
                        "teams": {"nodes": [{"id": "team-1", "key": "HELL", "name": "Hallucination"}]},
                    }
                ]
            }
        }

    monkeypatch.setattr(tool, "linear_graphql", fake_graphql)

    project = await tool.resolve_project("token", "HELL")

    assert project["id"] == "project-1"
    assert [call["variables"] for call in calls] == [{"project": "HELL"}, {"project": "HELL"}]

async def test_real_symphony_e2e_create_issue_accepts_parent_id(monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e")
    calls: list[dict[str, object]] = []

    async def fake_linear_graphql(_token: str, query: str, variables: dict[str, object]) -> dict[str, object]:
        calls.append({"query": query, "variables": variables})
        if "query Project" in query:
            return {
                "projects": {
                    "nodes": [
                        {
                            "id": "project-1",
                            "name": "HELL",
                            "slugId": "HELL",
                            "teams": {"nodes": [{"id": "team-1", "key": "HELL", "name": "HELL"}]},
                        }
                    ]
                }
            }
        if "query States" in query:
            return {"workflowStates": {"nodes": [{"id": "state-1", "name": "Todo", "type": "unstarted"}]}}
        if "mutation CreateIssue" in query:
            return {
                "issueCreate": {
                    "issue": {
                        "id": "issue-1",
                        "identifier": "HELL-1",
                        "title": "Child",
                        "url": "https://linear.app/x/issue/HELL-1",
                        "state": {"name": "Todo", "type": "unstarted"},
                        "assignee": None,
                        "delegate": None,
                        "labels": {"nodes": []},
                        "parent": {"id": "parent-1", "identifier": "HELL-0"},
                    }
                }
            }
        raise AssertionError(query)

    monkeypatch.setattr(tool, "linear_graphql", fake_linear_graphql)

    result = await tool.create_linear_issue("token", "HELL", "run-1", parent_id="parent-1")

    create_call = calls[-1]
    assert create_call["variables"]["input"]["parentId"] == "parent-1"
    assert result["issue"]["parent"]["id"] == "parent-1"

def test_real_symphony_e2e_pushes_runtime_config_before_waiting_for_poller_dispatch() -> None:
    source = (ROOT / "tools" / "real_symphony_e2e_run.py").read_text(encoding="utf-8")

    config_index = source.index('"/api/v1/runtime/config"')
    poller_index = source.index('"conductor-dispatch:poller-starts-one-shot"')

    assert config_index < poller_index
    assert "build_runtime_config_payload" in source
    assert "runtime-config:podium-pushed" in source
    assert "/api/v1/linear/webhooks/agent-session" not in source


def test_real_symphony_e2e_has_appendix_policy_and_read_only_probes() -> None:
    source = (ROOT / "tools" / "real_symphony_e2e_run.py").read_text(encoding="utf-8")

    assert "appendix:s0a-stale-policy-rejected" in source
    assert "appendix:s0b-view-read-only" in source


def test_real_symphony_e2e_fixture_repo_disables_local_git_signing() -> None:
    source = (ROOT / "tools" / "real_symphony_e2e_common.py").read_text(encoding="utf-8")

    assert "commit.gpgsign" in source
    assert "tag.gpgsign" in source


def test_crash_probe_candidate_targets_execute_attempts_only() -> None:
    tool = load_tool("real_symphony_e2e_analysis")
    leases = [
        {"attempt_id": "plan-1", "lease_id": "lease-plan"},
        {"attempt_id": "exec-1", "lease_id": "lease-exec"},
    ]

    assert tool.crash_probe_candidate(
        [
            {"attempt_id": "plan-1", "mode": "plan", "state": "running", "process_pid": 111},
            {"attempt_id": "exec-1", "mode": "execute", "state": "running", "process_pid": 222},
        ],
        leases,
    )["attempt_id"] == "exec-1"
    assert tool.crash_probe_candidate(
        [{"attempt_id": "plan-1", "mode": "plan", "state": "running", "process_pid": 111}],
        leases,
    ) is None


def test_crash_probe_failure_match_does_not_hide_other_failures() -> None:
    tool = load_tool("real_symphony_e2e_wait")

    assert tool._immediate_failure_matches_attempt(
        {"attempts": [{"attempt_id": "crash-attempt"}]},
        "crash-attempt",
    )
    assert not tool._immediate_failure_matches_attempt(
        {"attempts": [{"attempt_id": "crash-attempt"}, {"attempt_id": "other-failed"}]},
        "crash-attempt",
    )


def test_real_symphony_e2e_runtime_config_uses_explicit_codex_home_source() -> None:
    tool = load_tool("real_symphony_e2e")

    payload = tool.build_runtime_config_payload(
        runtime_group_id="group-1",
        version=7,
        codex_home_source="$SYMPHONY_E2E_CODEX_HOME_SOURCE",
    )

    assert payload["version"] == 7
    for profile in [payload["profiles"]["plan"], payload["profiles"]["work_item"]]:
        assert profile["settings"]["codex_home_source"] == "$SYMPHONY_E2E_CODEX_HOME_SOURCE"
        assert "model" not in profile["settings"]
        assert "auth.json" not in str(profile)
    assert payload["profiles"]["verify"]["backend"] == "local-verifier"
    assert payload["profiles"]["verify"]["settings"] == {}


def test_real_symphony_e2e_runtime_config_model_is_explicit_override_only(monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e")
    monkeypatch.delenv("SYMPHONY_E2E_CODEX_MODEL", raising=False)

    inherited = tool.build_runtime_config_payload(runtime_group_id="group-1", version=1)
    explicit = tool.build_runtime_config_payload(runtime_group_id="group-1", version=1, model="gpt-5.5")

    assert all("model" not in profile["settings"] for profile in inherited["profiles"].values())
    assert explicit["profiles"]["plan"]["settings"]["model"] == "gpt-5.5"
    assert explicit["profiles"]["work_item"]["settings"]["model"] == "gpt-5.5"
    assert "model" not in explicit["profiles"]["verify"]["settings"]


def test_real_symphony_e2e_runtime_config_carries_codex_execution_settings() -> None:
    tool = load_tool("real_symphony_e2e")

    payload = tool.build_runtime_config_payload(
        runtime_group_id="group-1",
        version=7,
        codex_home_source="$SYMPHONY_E2E_CODEX_HOME_SOURCE",
        codex_settings={"hard_turn_timeout_ms": 120000, "config_overrides": ["model_provider=custom"]},
    )

    for profile in [payload["profiles"]["plan"], payload["profiles"]["work_item"]]:
        assert profile["settings"]["hard_turn_timeout_ms"] == 120000
        assert profile["settings"]["config_overrides"] == ["model_provider=custom"]
    assert payload["profiles"]["verify"]["settings"] == {}


def test_real_symphony_e2e_cli_accepts_managed_run_scenarios() -> None:
    tool = load_tool("real_symphony_e2e")

    for scenario in ["basic", "parallel", "replan", "integration-conflict", "runtime-wait", "gate-normalization", "overall-dod"]:
        args = tool.parser().parse_args(["--managed-run-scenario", scenario])

        assert args.pipeline_scenario == scenario

    with pytest.raises(SystemExit):
        tool.parser().parse_args(["--pipeline-scenario", "basic"])


def test_real_symphony_e2e_gate_normalization_scenario_has_executable_intent() -> None:
    tool = load_tool("real_symphony_e2e_run")

    description = tool._pipeline_scenario_issue_description("gate-normalization", "run-1")
    intent = tool._pipeline_scenario_intent("gate-normalization")

    assert "SYMPHONY_CONFLICT_SHARED.md" in description
    assert "gate provenance" in description
    assert {"step": "pytest tests/test_smoke.py -q", "source": "acceptance_appendix"} in intent["required_gate_steps"]
    assert {"step": "test -f SYMPHONY_CONFLICT_SHARED.md", "source": "acceptance_appendix"} in intent["required_gate_steps"]


def test_real_symphony_e2e_appendix_hardening_probes_reference_existing_tests() -> None:
    tool = load_tool("real_symphony_e2e_acceptance")

    for _check_name, nodeids in tool.APPENDIX_PYTEST_HARDENING_PROBES:
        for nodeid in nodeids:
            path_text, _, test_name = nodeid.partition("::")
            test_path = ROOT / path_text

            assert test_path.is_file(), nodeid
            assert test_name, nodeid
            assert f"def {test_name}(" in test_path.read_text(encoding="utf-8"), nodeid


def test_real_symphony_e2e_defaults_to_hell_project() -> None:
    tool = load_tool("real_symphony_e2e")
    args = tool.parser().parse_args([])

    assert args.project_slug == "8ab43179fb54"


def test_real_symphony_e2e_parallel_scenario_raises_work_item_capacity() -> None:
    tool = load_tool("real_symphony_e2e")

    payload = tool.build_runtime_config_payload(
        runtime_group_id="group-1",
        version=1,
        pipeline_scenario="parallel",
    )

    assert payload["managed_run_policy"]["capacity"]["by_role"]["work_item"] == 2


def test_real_symphony_e2e_integration_conflict_scenario_forces_parallel_conflict_shape() -> None:
    tool = load_tool("real_symphony_e2e_run")

    payload = tool.build_runtime_config_payload(
        runtime_group_id="group-1",
        version=1,
        pipeline_scenario="integration-conflict",
    )
    description = tool._pipeline_scenario_issue_description("integration-conflict", "run-1")

    assert payload["managed_run_policy"]["capacity"]["by_role"]["work_item"] == 2
    assert "two independent parallel subtasks" in description
    assert "must not add a blocks dependency" in description
    assert "SYMPHONY_CONFLICT_SHARED.md" in description
    assert "different content" in description


def test_real_symphony_e2e_integration_conflict_fixture_tracks_shared_file(tmp_path) -> None:
    tool = load_tool("real_symphony_e2e_run")
    repo = tool.make_fixture_repo(tmp_path / "repo")

    tool._prepare_pipeline_scenario_fixture(repo, "integration-conflict")

    assert (repo / "SYMPHONY_CONFLICT_SHARED.md").read_text(encoding="utf-8")
    tracked_files = subprocess.check_output(["git", "ls-files"], cwd=repo, text=True).splitlines()
    assert "SYMPHONY_CONFLICT_SHARED.md" in tracked_files


def test_real_symphony_e2e_replan_scenario_forces_first_verify_failure() -> None:
    tool = load_tool("real_symphony_e2e")

    payload = tool.build_runtime_config_payload(
        runtime_group_id="group-1",
        version=1,
        pipeline_scenario="replan",
    )

    assert payload["profiles"]["verify"]["settings"] == {"force_first_verify_failure_for_replan": True}


def test_real_symphony_e2e_overall_dod_combines_required_probes() -> None:
    tool = load_tool("real_symphony_e2e_run")
    source = (ROOT / "tools" / "real_symphony_e2e_run.py").read_text(encoding="utf-8")

    payload = tool.build_runtime_config_payload(
        runtime_group_id="group-1",
        version=1,
        pipeline_scenario="overall-dod",
    )
    description = tool._pipeline_scenario_issue_description("overall-dod", "run-1")
    intent = tool._pipeline_scenario_intent("overall-dod")

    assert payload["managed_run_policy"]["capacity"]["by_role"]["work_item"] == 2
    assert payload["profiles"]["work_item"]["settings"]["emit_runtime_wait_probe"] is True
    assert payload["profiles"]["verify"]["settings"] == {"force_first_verify_failure_for_replan": True}
    assert "two independent parallel subtasks" in description
    assert "depend on both parallel subtasks" in description
    assert "SYMPHONY_CONFLICT_SHARED.md" in description
    assert "Runtime Wait" in description
    assert "replan" in description.lower()
    assert intent["parallel_dependency_shape"] == {
        "parallel_branch_node_ids": ["hell-parallel-a", "hell-parallel-b"],
        "downstream_node_ids": ["hell-downstream-integration"],
    }
    assert {"step": "pytest tests/test_smoke.py -q", "source": "acceptance_appendix"} in intent["required_gate_steps"]
    assert 'pipeline_scenario == "overall-dod"' in source
    assert "appendix:s0a-crashed-worker-lease-reclaimed" in source
    setup_source = (ROOT / "tools" / "real_symphony_e2e_run_setup.py").read_text(encoding="utf-8")
    environment_source = (ROOT / "tools" / "real_symphony_e2e_run_environment.py").read_text(encoding="utf-8")
    assert "SYMPHONY_E2E_LINEAR_FIXTURE_TOKEN" in environment_source
    assert "PODIUM_LINEAR_APP_ACCESS_TOKEN" not in source + setup_source + environment_source
    assert "external E2E issue setup" in environment_source
    assert "app:assignable" in source
    assert "app:mentionable" not in source
    assert "asyncpg.connect" in source
    assert "await start_e2e_postgres_if_needed" in source


def test_real_symphony_e2e_runtime_wait_scenario_enables_permission_probe() -> None:
    tool = load_tool("real_symphony_e2e_run")

    basic = type("Args", (), {"pipeline_scenario": "basic", "permission_approval_probe": False})()
    explicit = type("Args", (), {"pipeline_scenario": "basic", "permission_approval_probe": True})()
    runtime_wait = type("Args", (), {"pipeline_scenario": "runtime-wait", "permission_approval_probe": False})()
    overall = type("Args", (), {"pipeline_scenario": "overall-dod", "permission_approval_probe": False})()

    assert tool._effective_permission_approval_probe(basic) is False
    assert tool._effective_permission_approval_probe(explicit) is True
    assert tool._effective_permission_approval_probe(runtime_wait) is True
    assert tool._effective_permission_approval_probe(overall) is True

    payload = tool.build_runtime_config_payload(
        runtime_group_id="group-1",
        version=1,
        pipeline_scenario="runtime-wait",
    )

    assert payload["profiles"]["work_item"]["settings"]["emit_runtime_wait_probe"] is True


def test_real_symphony_e2e_overall_dod_scenario_is_not_downgraded() -> None:
    tool = load_tool("real_symphony_e2e_run")
    args = type("Args", (), {"pipeline_scenario": "overall-dod"})()

    assert tool._pipeline_scenario(args) == "overall-dod"


def test_real_symphony_e2e_overall_dod_runs_final_stage_checks_with_runtime_wait_probe() -> None:
    tool = load_tool("real_symphony_e2e_run")

    assert tool._should_run_final_pipeline_stage_checks(
        permission_approval_probe=True,
        pipeline_scenario="overall-dod",
    )
    assert not tool._should_run_final_pipeline_stage_checks(
        permission_approval_probe=True,
        pipeline_scenario="runtime-wait",
    )


def test_real_symphony_e2e_pipeline_projection_match_requires_current_revision() -> None:
    tool = load_tool("real_symphony_e2e_run")
    current = {
        "graph_revision": 2,
        "nodes": [{"node_id": "root", "state": "verify_passed", "gate_snapshot_hash": "sha256:gate"}],
        "linear_projections": [
            {
                "node_id": "root",
                "metadata": {
                    "graph_id": "graph-1",
                    "node_id": "root",
                    "gate_snapshot_hash": "sha256:gate",
                    "conductor_revision": 2,
                    "operator_status": "verify_passed",
                },
            }
        ],
    }
    stale = {
        **current,
        "linear_projections": [
            {
                "node_id": "old-root",
                "metadata": {
                    "graph_id": "graph-old",
                    "node_id": "old-root",
                    "gate_snapshot_hash": "sha256:old",
                    "conductor_revision": 1,
                    "operator_status": "verify_passed",
                },
            }
        ],
    }

    assert tool._pipeline_projection_matches_current_revision(current) is True
    assert tool._pipeline_projection_matches_current_revision(stale) is False


def test_real_symphony_e2e_defaults_to_bounded_codex_turn_timeout() -> None:
    tool = load_tool("real_symphony_e2e_run")
    entry = load_tool("real_symphony_e2e")
    args = entry.parser().parse_args([])

    settings = tool._codex_settings_from_args(args)

    assert settings["hard_turn_timeout_ms"] == 900000


def test_real_symphony_e2e_cli_rejects_codex_home_source_override() -> None:
    tool = load_tool("real_symphony_e2e")

    with pytest.raises(SystemExit):
        tool.parser().parse_args(["--codex-home-source", "~/.codex"])


def test_real_symphony_e2e_run_does_not_default_to_user_codex_home() -> None:
    source = (ROOT / "tools" / "real_symphony_e2e_run.py").read_text(encoding="utf-8")

    assert 'Path.home() / ".codex"' not in source
    assert "args.codex_home_source" not in source


def test_real_symphony_e2e_missing_linear_fixture_token_is_configuration_failure(monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e_run_environment")
    monkeypatch.delenv("SYMPHONY_E2E_LINEAR_FIXTURE_TOKEN", raising=False)

    with pytest.raises(tool.E2EConfigurationError) as error:
        tool.linear_fixture_token()

    assert error.value.failure_class == "environment_failure"
    assert error.value.error_code == "linear_fixture_token_required"
    assert error.value.retryable is False


def test_real_symphony_e2e_rejects_direct_user_codex_home_seed(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e")
    home = tmp_path / "home"
    source = home / ".codex"
    source.mkdir(parents=True)
    (source / "config.toml").write_text("model = 'gpt-5.3-codex'\n", encoding="utf-8")
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")

    with pytest.raises(RuntimeError, match="default user .codex"):
        tool.stage_codex_home_seed(source=source, destination=tmp_path / "run" / "codex-home-source")


def test_real_symphony_e2e_stages_codex_home_source_before_injection(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e")
    source = tmp_path / "user-codex"
    source.mkdir()
    (source / "config.toml").write_text("model = 'gpt-5.3-codex'\n", encoding="utf-8")
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")
    (source / "history.jsonl").write_text("do not copy\n", encoding="utf-8")
    (source / "sessions").mkdir()
    (source / "sessions" / "session.jsonl").write_text("do not copy\n", encoding="utf-8")

    staged = tool.stage_codex_home_seed(source=source, destination=tmp_path / "run" / "codex-home-source")

    assert staged == tmp_path / "run" / "codex-home-source"
    assert (staged / "config.toml").is_file()
    assert (staged / "auth.json").is_file()
    assert not (staged / "history.jsonl").exists()
    assert not (staged / "sessions").exists()


async def test_real_symphony_e2e_stages_codex_home_outside_evidence_root(tmp_path: Path, monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e_run_setup")
    source = tmp_path / "seed"
    source.mkdir()
    (source / "config.toml").write_text("model = 'gpt-5.3-codex'\n", encoding="utf-8")
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")
    monkeypatch.setattr(tool, "_linear_fixture_token", lambda: "linear-token")
    monkeypatch.setattr(tool, "podium_runtime_from_env", lambda _env: ("http://127.0.0.1:8090", 8090))
    monkeypatch.setattr(tool, "e2e_codex_home_seed_source", lambda: source)

    state = await tool.build_initial_state(
        SimpleNamespace(out=tmp_path / "evidence", pipeline_scenario="basic", permission_approval_probe=False)
    )
    staging_root = state.staged_codex_home.parent
    try:
        assert staging_root.name.startswith("symphony-e2e-codex-")
        assert not state.staged_codex_home.is_relative_to(state.root)
        assert not (state.root / "codex-home-source").exists()
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)


def test_real_symphony_e2e_scrubs_only_runtime_home_credentials(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e_preflight_core")
    data_root = tmp_path / "conductor-data"
    runtime_auth = data_root / "instances" / "inst-1" / "runtime-homes" / "plan" / "plan-1" / "codex" / "auth.json"
    runtime_auth.parent.mkdir(parents=True)
    runtime_auth.write_text('{"token":"runtime-secret"}\n', encoding="utf-8")
    runtime_config = runtime_auth.with_name("config.toml")
    runtime_config.write_text("model = 'gpt-5.5'\n", encoding="utf-8")
    seed_auth = tmp_path / "seed" / "auth.json"
    seed_auth.parent.mkdir()
    seed_auth.write_text('{"token":"seed-secret"}\n', encoding="utf-8")

    removed = tool.scrub_e2e_runtime_credentials(data_root)

    assert removed == 1
    assert not runtime_auth.exists()
    assert runtime_config.is_file()
    assert seed_auth.is_file()


def test_real_symphony_e2e_sanitizes_codex_config_template(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e")
    source = tmp_path / "user-codex"
    source.mkdir()
    (source / "config.toml").write_text(
        '\n'.join(
            [
                'model_provider = "custom"',
                'model = "gpt-5.5"',
                'notify = ["/Applications/Codex.app"]',
                '',
                '[model_providers.custom]',
                'name = "custom"',
                'base_url = "http://127.0.0.1:8080"',
                '',
                '[sandbox_workspace_write]',
                'network_access = true',
                '',
                '[projects."/Users/murphy/code/github/symphony"]',
                'trust_level = "trusted"',
                '',
                '[mcp_servers.node_repl.env]',
                'CODEX_HOME = "/Users/murphy/.codex"',
                'BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"',
                '',
                '[plugins."browser@openai-bundled"]',
                'enabled = true',
                '',
            ]
        ),
        encoding="utf-8",
    )
    (source / "auth.json").write_text('{"token":"secret-token"}\n', encoding="utf-8")

    staged = tool.stage_codex_home_seed(source=source, destination=tmp_path / "run" / "codex-home-source")

    config = (staged / "config.toml").read_text(encoding="utf-8")
    assert 'model_provider = "custom"' in config
    assert "[model_providers.custom]" in config
    assert "[sandbox_workspace_write]" in config
    assert "CODEX_HOME" not in config
    assert "BROWSER_USE" not in config
    assert "mcp_servers" not in config
    assert "plugins." not in config
    assert "projects." not in config
    assert "notify" not in config


def test_real_symphony_e2e_does_not_artifact_codex_home_source() -> None:
    source = (ROOT / "tools" / "real_symphony_e2e_run.py").read_text(encoding="utf-8")

    assert 'artifact("codex_home_source"' not in source
    assert "staged_path=" not in source
    assert "runtime-config:codex-home-source-staged" in source


async def test_real_symphony_e2e_create_blocks_relation_uses_blocker_as_issue(monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e")
    calls: list[dict[str, object]] = []

    async def fake_linear_graphql(_token: str, query: str, variables: dict[str, object]) -> dict[str, object]:
        calls.append({"query": query, "variables": variables})
        return {
            "issueRelationCreate": {
                "success": True,
                "issueRelation": {
                    "id": "rel-1",
                    "type": "blocks",
                    "issue": {"id": "blocker-1", "identifier": "HELL-2"},
                    "relatedIssue": {"id": "blocked-1", "identifier": "HELL-3"},
                },
            }
        }

    monkeypatch.setattr(tool, "linear_graphql", fake_linear_graphql)

    relation = await tool.create_linear_blocks_relation("token", "blocker-1", "blocked-1")

    assert relation["id"] == "rel-1"
    assert "issueRelationCreate" in calls[0]["query"]
    assert calls[0]["variables"] == {
        "input": {
            "issueId": "blocker-1",
            "relatedIssueId": "blocked-1",
            "type": "blocks",
        }
    }

def test_real_concurrent_schedule_probe_assertions_pass_for_expected_timeline() -> None:
    tool = load_tool("real_concurrent_schedule_probe")
    report = {"checks": [], "failures": []}
    timeline = [
        {
            "tick": 1,
            "background": {"blocked_waiting": 1},
            "started_this_tick": [{"issue_id": "A"}, {"issue_id": "B"}],
            "nodes": [
                {"issue_id": "A", "state": "executing", "is_dispatchable": True},
                {"issue_id": "B", "state": "executing", "is_dispatchable": True},
                {"issue_id": "C", "state": "planned", "is_dispatchable": False},
            ],
        },
        {
            "tick": 2,
            "background": {"blocked_waiting": 1},
            "started_this_tick": [],
            "nodes": [
                {"issue_id": "A", "state": "verify_passed", "is_dispatchable": True},
                {"issue_id": "B", "state": "verify_passed", "is_dispatchable": True},
                {"issue_id": "C", "state": "ready", "is_dispatchable": True},
            ],
        },
        {
            "tick": 3,
            "background": {"blocked_waiting": 0},
            "started_this_tick": [{"issue_id": "C"}],
            "nodes": [
                {"issue_id": "A", "state": "verify_passed", "is_dispatchable": True},
                {"issue_id": "B", "state": "verify_passed", "is_dispatchable": True},
                {"issue_id": "C", "state": "executing", "is_dispatchable": True},
            ],
        },
    ]

    tool._assert_schedule(
        report=report,
        timeline=timeline,
        runtime_started=[{"issue_id": "A"}, {"issue_id": "B"}, {"issue_id": "C"}],
        child_a_id="A",
        child_b_id="B",
        child_c_id="C",
        global_capacity=3,
    )

    assert [check["passed"] for check in report["checks"]] == [True, True, True, True, True]
    assert report["failures"] == []

def test_real_concurrent_schedule_probe_assertions_fail_when_blocked_child_starts_early() -> None:
    tool = load_tool("real_concurrent_schedule_probe")
    report = {"checks": [], "failures": []}

    tool._assert_schedule(
        report=report,
        timeline=[
            {
                "tick": 1,
                "background": {"blocked_waiting": 0},
                "started_this_tick": [{"issue_id": "A"}, {"issue_id": "B"}, {"issue_id": "C"}],
                "nodes": [
                    {"issue_id": "A", "state": "executing", "is_dispatchable": True},
                    {"issue_id": "B", "state": "executing", "is_dispatchable": True},
                    {"issue_id": "C", "state": "executing", "is_dispatchable": True},
                ],
            },
            {
                "tick": 2,
                "background": {"blocked_waiting": 0},
                "started_this_tick": [],
                "nodes": [
                    {"issue_id": "A", "state": "verify_passed", "is_dispatchable": True},
                    {"issue_id": "B", "state": "verify_passed", "is_dispatchable": True},
                    {"issue_id": "C", "state": "verify_passed", "is_dispatchable": True},
                ],
            },
        ],
        runtime_started=[{"issue_id": "A"}, {"issue_id": "B"}, {"issue_id": "C"}],
        child_a_id="A",
        child_b_id="B",
        child_c_id="C",
        global_capacity=3,
    )

    failed = {check["name"] for check in report["failures"]}
    assert "dependency-gate:C-waits-before-A-terminal" in failed
    assert "capacity-non-cause:C-waits-with-capacity-available" in failed

async def test_real_concurrent_schedule_probe_noop_pipeline_ingress_returns_zero() -> None:
    tool = load_tool("real_concurrent_schedule_probe")

    assert await tool.NoopPipelineIngress().poll() == 0

def test_real_run_observer_diagnoses_missing_pipeline_metadata() -> None:
    observer = load_tool("real_run_observer")

    findings = observer.diagnose(
        {
            "business_issue": {
                "identifier": "HELL-1",
                "state": "In Progress",
                "labels": ["performer:type/task"],
            },
            "failures": [],
        },
        {"failures": []},
    )

    assert findings == ["linear_tree:missing_pipeline_metadata"]


async def test_real_run_observer_exposes_missing_runtime_evidence_after_linear_terminal(
    tmp_path: Path,
    monkeypatch,
) -> None:
    observer = load_tool("real_run_observer")

    async def fetch_tree(_issue: str) -> dict[str, Any]:
        return {}

    monkeypatch.setattr(observer, "fetch_issue_tree", fetch_tree)
    monkeypatch.setattr(
        observer,
        "audit_tree",
        lambda _tree: {
            "business_issue": {"state": "Done", "state_type": "completed", "labels": []},
            "failures": [],
        },
    )
    monkeypatch.setattr(
        observer,
        "audit_runtime_evidence",
        lambda _data_root, *, instance_id: {
            "pass": False,
            "failures": ["managed_run_db_missing", "generation_logs_missing"],
        },
    )
    monkeypatch.setattr(observer, "runtime_log_tail", lambda _instance_root: ([], []))

    row = await observer.sample("HELL-1", tmp_path / "data" / "instances" / "inst-1")

    assert row["diagnosis"] == [
        "runtime:managed_run_db_missing",
        "runtime:generation_logs_missing",
    ]


async def test_real_run_observer_distinguishes_known_missing_db_from_pending_result(
    tmp_path: Path,
    monkeypatch,
) -> None:
    observer = load_tool("real_run_observer")
    runtime = {
        "pass": False,
        "failures": ["managed_run_db_missing"],
        "counts": {
            "runs": 0,
            "attempts": 0,
            "generation_logs": 1,
            "attempt_logs": 1,
            "turn_requests": 1,
            "turn_results": 0,
        },
        "runs": [],
    }

    async def fetch_tree(_issue: str) -> dict[str, Any]:
        return {}

    monkeypatch.setattr(observer, "fetch_issue_tree", fetch_tree)
    monkeypatch.setattr(
        observer,
        "audit_tree",
        lambda _tree: {
            "business_issue": {"state": "In Progress", "state_type": "started", "labels": []},
            "failures": [],
        },
    )
    monkeypatch.setattr(observer, "audit_runtime_evidence", lambda _data_root, *, instance_id: runtime)
    monkeypatch.setattr(observer, "runtime_log_tail", lambda _instance_root: ([], []))
    instance_root = tmp_path / "data" / "instances" / "inst-1"

    missing_db = await observer.sample("HELL-1", instance_root)
    runtime.update(
        {
            "failures": ["turn_result_missing:plan-1", "turn_results_missing"],
            "counts": {**runtime["counts"], "runs": 1, "attempts": 1},
            "runs": [{"run_id": "run-1", "state": "planning"}],
        }
    )
    active_attempt = await observer.sample("HELL-1", instance_root)

    assert missing_db["diagnosis"] == ["runtime:managed_run_db_missing"]
    assert active_attempt["diagnosis"] == []


def test_real_run_observer_uses_metadata_from_real_tree_audit() -> None:
    observer = load_tool("real_run_observer")
    tree_audit = load_tool("linear_tree_audit")
    audited = tree_audit.audit_tree(
        {
            "id": "issue-1",
            "identifier": "HELL-1",
            "title": "Business",
            "description": (
                "graph_id: graph-1\nnode_id: root\ngate_snapshot_hash: hash-1\n"
                "conductor_revision: rev-1\nManaged Run State:\n- run_id: run-1\n"
            ),
            "state": {"name": "In Progress", "type": "started"},
            "labels": {"nodes": [{"name": "performer:type/task"}]},
            "children": {"nodes": []},
            "inverseRelations": {"nodes": []},
        }
    )

    findings = observer.diagnose(audited, {"failures": []})

    assert "linear_tree:missing_pipeline_metadata" not in findings


async def test_real_run_observer_does_not_pass_nonterminal_business_issue(tmp_path: Path, monkeypatch) -> None:
    observer = load_tool("real_run_observer")

    async def nonterminal_sample(_issue: str, _instance_root: Path) -> dict[str, Any]:
        return {
            "linear_tree": {
                "business_issue": {"state": "In Progress", "state_type": "started"},
                "failures": [],
            },
            "linear_tree_error": None,
            "runtime": {"pass": True, "failures": [], "runs": [{"run_id": "run-1", "state": "done"}]},
            "diagnosis": [],
            "pending_diagnosis": [],
        }

    monkeypatch.setattr(observer, "sample", nonterminal_sample)
    result = await observer.observe(
        SimpleNamespace(
            issue="HELL-1",
            instance_root=tmp_path / "data" / "instances" / "inst-1",
            interval=0,
            timeout=0,
            pending_grace=0,
            single_sample=True,
            stop_on_diagnosis=True,
            jsonl=None,
            out=None,
        )
    )

    assert result["pass"] is False
    assert "observer:business_issue_not_successful" in result["failures"]


async def test_real_run_observer_promotes_pending_runtime_failure_at_deadline(tmp_path: Path, monkeypatch) -> None:
    observer = load_tool("real_run_observer")

    async def stalled_sample(_issue: str, _instance_root: Path) -> dict[str, Any]:
        return {
            "linear_tree": {
                "business_issue": {"state": "In Progress", "state_type": "started"},
                "failures": [],
            },
            "linear_tree_error": None,
            "runtime": {"pass": False, "failures": ["managed_run_db_missing"], "runs": [], "counts": {}},
            "diagnosis": [],
            "pending_diagnosis": ["runtime:managed_run_db_missing"],
        }

    monkeypatch.setattr(observer, "sample", stalled_sample)
    result = await observer.observe(
        SimpleNamespace(
            issue="HELL-1",
            instance_root=tmp_path / "data" / "instances" / "inst-1",
            interval=0,
            timeout=0,
            pending_grace=60,
            single_sample=False,
            stop_on_diagnosis=True,
            jsonl=None,
            out=None,
        )
    )

    assert result["pass"] is False
    assert "runtime:managed_run_db_missing" in result["failures"]


def test_real_run_observer_cli_uses_pipeline_sample_flag() -> None:
    observer = load_tool("real_run_observer")
    parser = observer.parser()

    args = parser.parse_args(["--issue", "HELL-1", "--instance-root", "/tmp/inst", "--single-sample"])

    assert args.single_sample is True
    with pytest.raises(SystemExit):
        parser.parse_args(["--issue", "HELL-1", "--instance-root", "/tmp/inst", "--once"])


def test_real_run_observer_reads_only_current_generation_and_attempt_logs(tmp_path: Path) -> None:
    observer = load_tool("real_run_observer")
    instance_root = tmp_path / "data" / "instances" / "inst-1"
    legacy_log = instance_root / "logs" / "performer.log"
    generation_log = instance_root / "logs" / "performer-000001.log"
    attempt_log = instance_root / "state" / "managed_run" / "execute-1" / "attempt.log"
    legacy_log.parent.mkdir(parents=True)
    legacy_log.write_text("legacy-only\n", encoding="utf-8")
    generation_log.write_text("event=generation token=secret-value\n", encoding="utf-8")
    attempt_log.parent.mkdir(parents=True)
    attempt_log.write_text("event=attempt authorization: Bearer secret-value\n", encoding="utf-8")

    sources, lines = observer.runtime_log_tail(instance_root)
    rendered = "\n".join(lines)

    assert sources == [
        "logs/performer-000001.log",
        "state/managed_run/execute-1/attempt.log",
    ]
    assert "legacy-only" not in rendered
    assert "secret-value" not in rendered

def test_real_symphony_e2e_common_has_no_workflow_patch_helpers() -> None:
    tool = load_tool("real_symphony_e2e")

    assert not hasattr(tool, "patch_workflow")
    assert not hasattr(tool, "patch_e2e_gate_mode")

def test_real_symphony_e2e_keeps_fixture_credentials_out_of_managed_runtime() -> None:
    tool = load_tool("real_symphony_e2e_podium")
    managed = tool.podium_managed_env(
        {
            "SYMPHONY_E2E_LINEAR_FIXTURE_TOKEN": "fixture-token",
            "PODIUM_LINEAR_APP_ACCESS_TOKEN": "removed-token",
            "PODIUM_LINEAR_APPLICATION_ID": "removed-app-user",
            "PODIUM_LINEAR_ACCESS_TOKEN": "removed-operator-token",
            "LINEAR_API_KEY": "removed-human-token",
            "LINEAR_CLIENT_ID": "client-id",
            "LINEAR_CLIENT_SECRET": "client-secret",
            "LINEAR_REDIRECT_URI": "http://127.0.0.1:8090/api/v1/linear/oauth/callback",
        },
        database_url="postgresql://podium.test/podium",
        podium_base_url="http://127.0.0.1:8090",
        secret_key="run-secret",
    )

    assert managed["LINEAR_CLIENT_ID"] == "client-id"
    assert managed["LINEAR_CLIENT_SECRET"] == "client-secret"
    assert managed["LINEAR_REDIRECT_URI"].endswith("/api/v1/linear/oauth/callback")
    assert managed["PODIUM_DATABASE_URL"] == "postgresql://podium.test/podium"
    assert managed["PODIUM_BASE_URL"] == "http://127.0.0.1:8090"
    assert managed["PODIUM_DEBUG_AUTH"] == "1"
    assert managed["PODIUM_SECURE_COOKIES"] == "0"
    assert "SYMPHONY_E2E_LINEAR_FIXTURE_TOKEN" not in managed
    assert "PODIUM_LINEAR_APP_ACCESS_TOKEN" not in managed
    assert "PODIUM_LINEAR_APPLICATION_ID" not in managed
    assert "PODIUM_LINEAR_ACCESS_TOKEN" not in managed
    assert "LINEAR_API_KEY" not in managed


def test_real_symphony_e2e_wait_uses_poller_stage_name_not_webhook() -> None:
    source = (ROOT / "tools" / "real_symphony_e2e_wait.py").read_text(encoding="utf-8")

    assert 'mark_stage("poller_queued"' in source
    assert 'mark_stage("webhook_queued"' not in source


def test_real_symphony_e2e_instance_payload_always_requires_delegate_filter() -> None:
    tool = load_tool("real_symphony_e2e")

    payload = tool.build_instance_payload(
        run_id="run-1",
        fixture=Path("/tmp/fixture"),
        project_slug="AI",
        agent_app_user_id="agent-1",
        pipeline_gates=False,
    )

    assert payload["linear_filters"] == {
        "linear_agent_app_user_id": "agent-1",
    }
    assert "managed_run_profile" not in payload
    assert "workflow_profile" not in payload
    assert "workflow_inputs" not in payload

def test_real_symphony_e2e_real_instance_payload_requires_delegate() -> None:
    tool = load_tool("real_symphony_e2e")

    payload = tool.build_instance_payload(
        run_id="run-1",
        fixture=Path("/tmp/fixture"),
        project_slug="AI",
        agent_app_user_id="agent-1",
        pipeline_gates=True,
    )

    assert payload["linear_filters"] == {
        "linear_agent_app_user_id": "agent-1",
    }
    assert "managed_run_profile" not in payload
    assert "workflow_profile" not in payload
    assert "workflow_inputs" not in payload

def test_real_symphony_e2e_run_no_longer_patches_workflow_content() -> None:
    source = (ROOT / "tools" / "real_symphony_e2e_run.py").read_text(encoding="utf-8")
    common_source = (ROOT / "tools" / "real_symphony_e2e_common.py").read_text(encoding="utf-8")

    assert "patch_workflow" not in source
    assert "patch_workflow" not in common_source
    assert "patch_e2e_gate_mode" not in common_source
    assert "workflow_content" not in source
    assert '["workflow_path"]' not in source
    assert "workflow_path" not in source


def test_real_symphony_e2e_run_uses_managed_runs_view_not_legacy_runs_or_gate_children() -> None:
    source = (ROOT / "tools" / "real_symphony_e2e_run.py").read_text(encoding="utf-8")

    assert '"/api/managed-runs"' in source
    assert '"/api/pipeline"' not in source
    assert '"/api/runs"' not in source
    assert '"/api/runs/' not in source
    assert "pipeline_runs" not in source
    assert "phase_terminal" not in source
    assert "performer:type/gate" not in source
    assert "performer:type/evidence" not in source


def test_real_symphony_e2e_bootstrap_uses_installation_and_binding_apis() -> None:
    source = "\n".join(
        (ROOT / "tools" / name).read_text(encoding="utf-8")
        for name in ("real_symphony_e2e_podium.py", "real_symphony_e2e_podium_runtime.py")
    )

    for route in [
        "/api/v1/linear/installations/oauth",
        "/api/v1/linear/installations",
        "/api/v1/linear/projects",
        "/api/v1/onboarding/runtime/enrollment-token",
        "/api/v1/conductors/{conductor_id}/binding",
    ]:
        assert route in source
    assert "/api/v1/runtime/enrollment-tokens" not in source
    assert 'get("PODIUM_LINEAR_APP_ACCESS_TOKEN"' not in source
    assert '["PODIUM_LINEAR_APP_ACCESS_TOKEN"] =' not in source


def test_real_symphony_e2e_queries_and_restarts_have_no_agent_session_or_fixture_leak() -> None:
    linear_sources = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (ROOT / "tools").glob("real_symphony_e2e_linear*.py")
    )
    restart_sources = "\n".join(
        (ROOT / "tools" / name).read_text(encoding="utf-8")
        for name in ("real_symphony_e2e_run_runtime.py", "real_symphony_e2e_run_final.py")
    )

    assert "agentSessions" not in linear_sources
    assert "AgentSession" not in linear_sources
    assert "env=state.env" not in restart_sources
    assert restart_sources.count("managed_runtime_env(state.env)") >= 2


def test_real_symphony_e2e_binding_payload_is_single_project_and_repository() -> None:
    tool = load_tool("real_symphony_e2e_podium_runtime")

    payload = tool.build_project_binding_payload("project-1", Path("/tmp/fixture"))

    assert payload == {
        "linear_project_id": "project-1",
        "repository": {"mode": "local_path", "value": "/tmp/fixture"},
    }
    assert "managed_run_profile" not in payload


def test_real_symphony_e2e_uses_the_registered_oauth_callback_origin() -> None:
    tool = load_tool("real_symphony_e2e_podium")

    origin, port = tool.podium_runtime_from_env(
        {
            "LINEAR_CLIENT_ID": "client-id",
            "LINEAR_CLIENT_SECRET": "client-secret",
            "LINEAR_REDIRECT_URI": "http://127.0.0.1:8090/api/v1/linear/oauth/callback",
        }
    )

    assert origin == "http://127.0.0.1:8090"
    assert port == 8090


def test_real_symphony_e2e_resolves_the_selected_project_from_installation_discovery() -> None:
    tool = load_tool("real_symphony_e2e_podium")

    project = tool.resolve_installation_project(
        [
            {"id": "project-1", "name": "First", "slug_id": "FIRST"},
            {"id": "project-2", "name": "Hell", "slug_id": "HELL"},
        ],
        "hell",
    )

    assert project["id"] == "project-2"

async def test_real_symphony_e2e_waits_for_delegate_visibility_before_poller_dispatch(monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e")
    seen = [
        {"id": "issue-1", "delegate": None},
        {"id": "issue-1", "delegate": {"id": "agent-1"}},
    ]

    async def fake_fetch(_token: str, _issue_id: str) -> dict[str, object]:
        return seen.pop(0)

    monkeypatch.setattr(tool, "fetch_linear_issue", fake_fetch)

    issue = await tool.wait_for_linear_delegate_visible(
        "token",
        "issue-1",
        "agent-1",
        timeout_seconds=1,
        poll_seconds=0,
    )

    assert issue["delegate"] == {"id": "agent-1"}
    assert seen == []


async def test_real_symphony_e2e_linear_facade_waits_without_recursive_fetch(monkeypatch) -> None:
    tool = load_tool("real_symphony_e2e_linear")
    seen = [
        {"id": "issue-1", "delegate": None},
        {"id": "issue-1", "delegate": {"id": "agent-1"}},
    ]

    async def fake_linear_graphql(_token: str, _query: str, _variables: dict[str, object]) -> dict[str, object]:
        return {"issue": seen.pop(0)}

    monkeypatch.setattr(tool, "linear_graphql", fake_linear_graphql)

    issue = await tool.wait_for_linear_delegate_visible(
        "token",
        "issue-1",
        "agent-1",
        timeout_seconds=1,
        poll_seconds=0,
    )

    assert issue["delegate"] == {"id": "agent-1"}
    assert seen == []


def test_real_symphony_e2e_evidence_redacts_tokens(tmp_path: Path) -> None:
    tool = load_tool("real_symphony_e2e")
    evidence = tool.Evidence(tmp_path / "evidence.json")

    evidence.check(
        "token-check",
        True,
        body={
            "enrollment_token": "secret-enrollment",
            "runtime_token": "secret-runtime",
            "nested": {"proxy_token": "secret-proxy"},
        },
    )

    text = (tmp_path / "evidence.json").read_text(encoding="utf-8")
    assert "secret-enrollment" not in text
    assert "secret-runtime" not in text
    assert "secret-proxy" not in text
    assert '"enrollment_token": "<redacted>"' in text
    assert '"runtime_token": "<redacted>"' in text
    assert '"proxy_token": "<redacted>"' in text

def test_real_run_evidence_bundle_copies_codex_overload_probe(tmp_path: Path) -> None:
    tool = load_tool("real_run_evidence_bundle")
    from conductor.conductor_managed_run_store import ConductorManagedRunStore

    data_root = tmp_path / "data"
    instance_root = data_root / "instances" / "inst-1"
    store = ConductorManagedRunStore(data_root / "managed_run")
    accepted = store.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1"},
        instance_id="inst-1",
    )
    attempt, request, result = _managed_turn_fixture(accepted.run_id)
    store.merge_run_payload(accepted.run_id, {"completed_attempts": [attempt]})
    _write_managed_turn_artifacts(instance_root, attempt, request, result)
    probe = tmp_path / "codex-overload-probe.json"
    probe.write_text('{"pass": true, "overload_retry_count": 1}', encoding="utf-8")

    manifest = tool.bundle(
        type(
            "Args",
            (),
            {
                "instance_root": instance_root,
                "out": tmp_path / "bundle",
                "business_issue": None,
                "linear_tree": None,
                "observer": None,
                "cleanup_before": None,
                "cleanup_after": None,
                "codex_overload_probe": probe,
            },
        )()
    )

    assert manifest["copied"]["codex_overload_probe"] is True
    assert manifest["runtime_artifacts_pass"] is True
    assert manifest["bundle_valid"] is False
    assert manifest["pass"] is False
    assert manifest["supplied"]["business_issue"]["status"] == "missing"
    assert manifest["supplied"]["linear_tree"]["status"] == "missing"
    assert str(instance_root) not in json.dumps(manifest, sort_keys=True)
    assert "codex-overload-probe.json" in manifest["files"]
    assert "managed_run/managed_run.db" in manifest["files"]
    assert "instances/inst-1/logs/performer-000001.log" in manifest["files"]
    assert "instances/inst-1/state/managed_run/plan-1/attempt.log" in manifest["files"]


def test_real_run_evidence_bundle_publishes_fresh_hashed_complete_archive(tmp_path: Path) -> None:
    tool = load_tool("real_run_evidence_bundle")
    from conductor.conductor_managed_run_store import ConductorManagedRunStore

    data_root = tmp_path / "data"
    instance_root = data_root / "instances" / "inst-1"
    store = ConductorManagedRunStore(data_root / "managed_run")
    accepted = store.accept_dispatch(
        {"issue_id": "issue-1", "issue_identifier": "HELL-1"},
        instance_id="inst-1",
    )
    attempt, request, result = _managed_turn_fixture(accepted.run_id)
    store.merge_run_payload(accepted.run_id, {"completed_attempts": [attempt]})
    _write_managed_turn_artifacts(instance_root, attempt, request, result)
    supplied: dict[str, Path] = {}
    for name in ("business_issue", "linear_tree", "cleanup_before", "cleanup_after"):
        path = tmp_path / f"{name}.json"
        path.write_text('{"pass":true}', encoding="utf-8")
        supplied[name] = path
    observer = tmp_path / "observer.jsonl"
    observer.write_text('{"event":"sample"}\n', encoding="utf-8")
    supplied["observer"] = observer
    out = tmp_path / "bundle"
    out.mkdir()
    (out / "stale.txt").write_text("stale", encoding="utf-8")

    manifest = tool.bundle(
        SimpleNamespace(
            instance_root=instance_root,
            out=out,
            codex_overload_probe=None,
            **supplied,
        )
    )

    assert manifest["pass"] is True
    assert manifest["bundle_valid"] is True
    assert manifest["runtime_artifacts_pass"] is True
    assert not (out / "stale.txt").exists()
    assert set(manifest["sha256"]) == set(manifest["files"]) - {"manifest.json"}
    for relative, expected in manifest["sha256"].items():
        assert hashlib.sha256((out / relative).read_bytes()).hexdigest() == expected


def test_real_run_evidence_bundle_rejects_empty_instance_root(tmp_path: Path) -> None:
    tool = load_tool("real_run_evidence_bundle")
    instance_root = tmp_path / "data" / "instances" / "inst-1"

    manifest = tool.bundle(
        SimpleNamespace(
            instance_root=instance_root,
            out=tmp_path / "bundle",
            business_issue=None,
            linear_tree=None,
            observer=None,
            cleanup_before=None,
            cleanup_after=None,
            codex_overload_probe=None,
        )
    )

    assert manifest["pass"] is False
    assert manifest["runtime_audit_pass"] is False
    assert set(manifest["failures"]) >= {
        "managed_run_db_missing",
        "generation_logs_missing",
        "attempt_logs_missing",
    }


def test_real_run_evidence_bundle_cli_exits_nonzero_with_manifest_when_required_evidence_is_missing(tmp_path: Path) -> None:
    out = tmp_path / "bundle"

    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "tools" / "real_run_evidence_bundle.py"),
            "--instance-root",
            str(tmp_path / "data" / "instances" / "inst-1"),
            "--out",
            str(out),
        ],
        text=True,
        capture_output=True,
    )

    assert result.returncode == 1
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["pass"] is False
    assert "managed_run_db_missing" in manifest["failures"]


def test_real_symphony_e2e_run_does_not_call_removed_workflow_api_routes() -> None:
    source = (ROOT / "tools" / "real_symphony_e2e_run.py").read_text(encoding="utf-8")

    assert "preview-workflow" not in source
    assert "generate-workflow" not in source
    assert "validate-workflow" not in source
    assert "workflow-profiles" not in source


def test_real_codex_thread_resume_probe_summarizes_resume_and_fallback() -> None:
    tool = load_tool("real_codex_thread_resume_probe")

    summary = tool.summarize_probe(
        first_thread_id="thread-1",
        resumed_thread_id="thread-1",
        fallback_requested_thread_id="missing-thread",
        fallback_thread_id="thread-2",
        fallback_events=[{"event": "thread_resume_failed", "thread_id": "missing-thread"}],
    )

    assert summary["resume_same_thread"] is True
    assert summary["fallback_recorded"] is True
    assert summary["fallback_started_new_thread"] is True
    assert summary["pass"] is True

def test_real_codex_thread_resume_probe_uses_structured_prompt() -> None:
    tool = load_tool("real_codex_thread_resume_probe")

    prompt = tool.probe_prompt("resume probe")

    assert "resume probe" in prompt
    assert "summary" in prompt
    assert "test_commands" in prompt
    assert "changed_files" in prompt
    assert "remaining_risks" in prompt
    assert "ready_for_review" in prompt

def test_real_codex_continuation_probe_requires_two_turns_on_one_thread() -> None:
    tool = load_tool("real_codex_continuation_probe")

    summary = tool.summarize_probe(
        SimpleNamespace(
            success=True,
            thread_id="thread-1",
            turn_count=2,
            structured_result={"next_action": "ready_for_review"},
        ),
        [
            {"event": "turn_started", "thread_id": "thread-1", "turn_id": "turn-1"},
            {"event": "turn_completed", "thread_id": "thread-1", "turn_id": "turn-1"},
            {"event": "turn_started", "thread_id": "thread-1", "turn_id": "turn-2"},
            {"event": "turn_completed", "thread_id": "thread-1", "turn_id": "turn-2"},
        ],
        [1],
    )

    assert summary["pass"] is True
    assert summary["turn_count"] == 2
    assert summary["same_thread"] is True
    assert summary["continuation_calls"] == [1]

def test_real_codex_continuation_probe_rejects_resume_only_single_turn() -> None:
    tool = load_tool("real_codex_continuation_probe")

    summary = tool.summarize_probe(
        SimpleNamespace(
            success=True,
            thread_id="thread-1",
            turn_count=1,
            structured_result={"next_action": "ready_for_review"},
        ),
        [
            {"event": "turn_started", "thread_id": "thread-1", "turn_id": "turn-1"},
            {"event": "turn_completed", "thread_id": "thread-1", "turn_id": "turn-1"},
        ],
        [],
    )

    assert summary["pass"] is False
