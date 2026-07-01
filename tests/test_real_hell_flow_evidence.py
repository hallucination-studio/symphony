from __future__ import annotations

import os
from pathlib import Path

import pytest


pytestmark = pytest.mark.skipif(
    os.environ.get("SYMPHONY_REAL_HELL_FLOW") != "1" or not os.environ.get("LINEAR_API_KEY"),
    reason="set SYMPHONY_REAL_HELL_FLOW=1 and LINEAR_API_KEY to run the real HELL flow evidence suite",
)


def test_real_hell_flow_evidence_harness_scores_all_plan_flows(tmp_path: Path) -> None:
    from symphony.real_hell_flow import run_real_hell_flow_evidence

    report = run_real_hell_flow_evidence(tmp_path)

    assert report["project"]["name"] == "HELL"
    assert report["project"]["slug_id"]
    assert report["workspace_root"]
    assert len(report["linear"]["created_issue_identifiers"]) == 26
    assert len(set(report["linear"]["created_issue_identifiers"])) == 26
    assert sorted(report["linear"]["per_flow"]) == [f"FLOW-{index:03d}" for index in range(1, 27)]
    assert sorted(report["flows"]) == [f"FLOW-{index:03d}" for index in range(1, 27)]
    for flow_id, bundle in report["flows"].items():
        assert bundle["test_id"] == flow_id
        assert bundle["profile"] == "real_hell"
        assert bundle["score"] == 4
        assert bundle["result"] == "pass"
        assert bundle["real_linear_evidence"]["project_name"] == "HELL"
        assert bundle["real_linear_evidence"]["issue_identifier"]
        assert bundle["real_linear_evidence"]["issue_identifier"] in report["linear"]["created_issue_identifiers"]
        assert bundle["real_linear_evidence"]["flow_id"] == flow_id
        assert (
            report["linear"]["per_flow"][flow_id]["issue_identifier"]
            == bundle["real_linear_evidence"]["issue_identifier"]
        )
        assert bundle["real_runtime_evidence"]
        assert bundle["score_reason"]
