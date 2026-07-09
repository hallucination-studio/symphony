from __future__ import annotations

from real_symphony_e2e_analysis_appendix import (
    APPENDIX_EXIT_BAR_ITEMS,
    APPENDIX_FEATURE_SCORE_REQUIREMENTS,
    appendix_exit_bar_audit,
    appendix_feature_score_audit,
    pipeline_has_conflict_escalation_evidence,
    pipeline_integrations_terminal,
    pipeline_node_effective_state,
    pipeline_nodes_terminal,
)
import real_symphony_e2e_analysis_failure as _failure
from real_symphony_e2e_analysis_failure import (
    _human_action_children,
    _int_value,
    _max_counter_from_text,
    audit_expected_failure_run,
    build_instance_payload,
    crash_probe_candidate,
    done_state_id_for_human_action,
    e2e_human_action_resume_response,
    human_action_description_with_response,
    kill_performer_for_crash_probe,
    parent_comment_negative_control_body,
    should_complete_conductor_human_action,
)
from real_symphony_e2e_linear import (
    fetch_linear_human_action_issue,
    move_linear_issue_to_state,
    update_linear_issue_description,
)
from real_symphony_e2e_analysis_plan import (
    _add_plan_root_cause,
    _analysis_context,
    _intent_spec_summary,
    _plan_proposal_shape,
    _preferred_intent_context,
    _read_analysis_payload,
    analyze_plan_artifacts,
)
from real_symphony_e2e_analysis_runtime import (
    conductor_human_actions,
    conductor_pipeline_nodes,
    write_wait_artifacts,
)


async def complete_conductor_human_action(*args, **kwargs):
    originals = (
        _failure.fetch_linear_human_action_issue,
        _failure.update_linear_issue_description,
        _failure.move_linear_issue_to_state,
    )
    _failure.fetch_linear_human_action_issue = fetch_linear_human_action_issue
    _failure.update_linear_issue_description = update_linear_issue_description
    _failure.move_linear_issue_to_state = move_linear_issue_to_state
    try:
        return await _failure.complete_conductor_human_action(*args, **kwargs)
    finally:
        (
            _failure.fetch_linear_human_action_issue,
            _failure.update_linear_issue_description,
            _failure.move_linear_issue_to_state,
        ) = originals
