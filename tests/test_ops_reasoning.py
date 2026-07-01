from performer_api.ops_reasoning import explain_issue_state


def test_stalled_explanation_includes_failure_context() -> None:
    detail = {
        "status": "stalled",
        "last_event_type": "tool_call_failed",
        "failure_summary": "no Codex output arrived for 14 minutes after a tool timeout",
    }

    assert "no Codex output" in explain_issue_state(detail)


def test_retrying_explanation_never_returns_bare_status() -> None:
    detail = {"status": "retrying", "failure_summary": "worker exited: boom"}

    assert explain_issue_state(detail) == "Retrying because worker exited: boom"


def test_unknown_state_uses_plain_fallback() -> None:
    assert explain_issue_state({"status": "completed"}) == "completed"
