use crate::domain::{ProjectBinding, RootCandidate};
use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentAssignment {
    pub root_id: String,
    pub priority: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScheduleAction {
    Keep(CurrentAssignment),
    Stop { assignment: CurrentAssignment },
    Start { candidate: RootCandidate },
}

pub fn schedule(
    binding: &ProjectBinding,
    candidates: &[RootCandidate],
    current: &[CurrentAssignment],
) -> Vec<ScheduleAction> {
    // A plan containing Stop actions is deliberately terminal for this pass:
    // the caller must observe that those process trees have exited and call
    // `schedule` again before any replacement Start can be returned.
    let capacity = binding.concurrency as usize;

    // Existing assignments are retained in their current slot order. A duplicate
    // Root cannot occupy another slot, so duplicate assignments are stopped.
    let mut unique_current = Vec::with_capacity(current.len());
    let mut duplicate_assignments = Vec::new();
    let mut seen_current = std::collections::HashSet::new();
    for assignment in current {
        if seen_current.insert(assignment.root_id.clone()) {
            unique_current.push(assignment.clone());
        } else {
            duplicate_assignments.push(assignment.clone());
        }
    }

    let mut stop_actions: Vec<_> = duplicate_assignments
        .into_iter()
        .map(|assignment| ScheduleAction::Stop { assignment })
        .collect();
    let retained_count = capacity.min(unique_current.len());
    let mut ranked_current = unique_current.clone();
    ranked_current.sort_by(compare_current_assignments);
    let retained_roots: std::collections::HashSet<_> = ranked_current
        .into_iter()
        .take(retained_count)
        .map(|assignment| assignment.root_id)
        .collect();
    stop_actions.extend(
        unique_current
            .iter()
            .filter(|assignment| !retained_roots.contains(&assignment.root_id))
            .cloned()
            .map(|assignment| ScheduleAction::Stop { assignment }),
    );
    if !stop_actions.is_empty() {
        return stop_actions;
    }

    let mut candidates_by_id = std::collections::BTreeMap::new();
    for candidate in candidates {
        if unique_current.iter().any(|assignment| assignment.root_id == candidate.id) {
            continue;
        }
        match candidates_by_id.get(&candidate.id) {
            Some(existing) if compare_candidates(candidate, existing) != Ordering::Less => {}
            _ => {
                candidates_by_id.insert(candidate.id.clone(), candidate.clone());
            }
        }
    }
    let mut unique_candidates: Vec<_> = candidates_by_id.into_values().collect();
    unique_candidates.sort_by(compare_candidates);

    let free_slots = capacity.saturating_sub(unique_current.len());
    if free_slots > 0 {
        let mut actions: Vec<_> = unique_current.into_iter().map(ScheduleAction::Keep).collect();
        actions.extend(
            unique_candidates
                .into_iter()
                .take(free_slots)
                .map(|candidate| ScheduleAction::Start { candidate }),
        );
        return actions;
    }

    unique_current.into_iter().map(ScheduleAction::Keep).collect()
}

fn linear_priority_rank(priority: u8) -> u8 {
    match priority {
        1..=4 => priority,
        0 => 5,
        _ => 6,
    }
}

fn compare_priority_values(left: u8, right: u8) -> Ordering {
    linear_priority_rank(left).cmp(&linear_priority_rank(right))
}

fn compare_current_assignments(left: &CurrentAssignment, right: &CurrentAssignment) -> Ordering {
    compare_priority_values(left.priority, right.priority)
        .then_with(|| left.root_id.cmp(&right.root_id))
}

fn compare_candidates(left: &RootCandidate, right: &RootCandidate) -> Ordering {
    compare_priority_values(left.priority, right.priority)
        .then_with(|| left.created_at.cmp(&right.created_at))
        .then_with(|| left.id.cmp(&right.id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{AgentKind, RoleLaunchConfig};

    fn binding(concurrency: u32) -> ProjectBinding {
        let role =
            || RoleLaunchConfig { agent: AgentKind::Codex, model: None, reasoning_effort: None };
        ProjectBinding {
            project_id: "project-1".into(),
            routing_label: "core".into(),
            repository_path: "/repo".into(),
            base_branch: "main".into(),
            concurrency,
            completed_workspace_retention: None,
            reconcile_agent: role().agent,
            reconcile_model: None,
            reconcile_reasoning_effort: None,
            artist_agent: role().agent,
            artist_model: None,
            artist_reasoning_effort: None,
            critic_agent: role().agent,
            critic_model: None,
            critic_reasoning_effort: None,
        }
    }

    fn root(id: &str, priority: u8, created_at: &str) -> RootCandidate {
        RootCandidate { id: id.into(), priority, created_at: created_at.into() }
    }

    #[test]
    fn sorts_candidates_by_linear_priority_then_creation_then_id() {
        let actions = schedule(
            &binding(3),
            &[
                root("normal", 3, "2024-01-01T00:00:00Z"),
                root("urgent-late", 1, "2024-01-02T00:00:00Z"),
                root("urgent-early-z", 1, "2024-01-01T00:00:00Z"),
                root("urgent-early-a", 1, "2024-01-01T00:00:00Z"),
            ],
            &[],
        );

        let ids: Vec<_> = actions
            .into_iter()
            .filter_map(|action| match action {
                ScheduleAction::Start { candidate } => Some(candidate.id),
                _ => None,
            })
            .collect();
        assert_eq!(ids, ["urgent-early-a", "urgent-early-z", "urgent-late"]);
    }

    #[test]
    fn replied_needs_human_root_uses_ordinary_linear_ordering() {
        // Linear discovery normalizes a replied top-level Needs Human Root to
        // the same candidate shape; scheduling must not assign it a special rank.
        let replied_needs_human = root("needs-human-replied", 2, "2024-01-02T00:00:00Z");
        let actions = schedule(
            &binding(5),
            &[
                replied_needs_human,
                root("todo-urgent", 1, "2024-01-03T00:00:00Z"),
                root("todo-high-early", 2, "2024-01-01T00:00:00Z"),
                root("todo-high-tie", 2, "2024-01-02T00:00:00Z"),
                root("todo-normal", 3, "2024-01-01T00:00:00Z"),
            ],
            &[],
        );

        let ids: Vec<_> = actions
            .into_iter()
            .filter_map(|action| match action {
                ScheduleAction::Start { candidate } => Some(candidate.id),
                _ => None,
            })
            .collect();
        assert_eq!(
            ids,
            [
                "todo-urgent",
                "todo-high-early",
                "needs-human-replied",
                "todo-high-tie",
                "todo-normal",
            ]
        );
    }

    #[test]
    fn higher_priority_waiting_root_does_not_preempt_running_root() {
        let current = [CurrentAssignment { root_id: "low".into(), priority: 2 }];
        let actions = schedule(&binding(1), &[root("urgent", 1, "2024-01-01")], &current);
        assert_eq!(actions, [ScheduleAction::Keep(current[0].clone())]);
    }

    #[test]
    fn equal_priority_does_not_preempt() {
        let current = [CurrentAssignment { root_id: "existing".into(), priority: 1 }];
        let actions = schedule(&binding(1), &[root("waiting", 1, "2024-01-01")], &current);
        assert_eq!(actions, [ScheduleAction::Keep(current[0].clone())]);
    }

    #[test]
    fn lower_linear_number_is_higher_priority_and_no_priority_is_lowest() {
        for waiting_priority in 1..=4 {
            let current = [CurrentAssignment { root_id: "none".into(), priority: 0 }];
            let actions =
                schedule(&binding(1), &[root("waiting", waiting_priority, "2024-01-01")], &current);
            assert_eq!(actions, [ScheduleAction::Keep(current[0].clone())]);
        }

        let current = [CurrentAssignment { root_id: "urgent".into(), priority: 1 }];
        let actions = schedule(&binding(1), &[root("high", 2, "2024-01-01")], &current);
        assert!(
            matches!(actions.as_slice(), [ScheduleAction::Keep(assignment)] if assignment.root_id == "urgent")
        );
    }

    #[test]
    fn duplicate_roots_are_not_started_twice_or_kept_in_two_slots() {
        let current = [CurrentAssignment { root_id: "running".into(), priority: 3 }];
        let actions = schedule(
            &binding(3),
            &[
                root("new", 3, "2024-01-01"),
                root("new", 3, "2024-01-01"),
                root("running", 1, "2024-01-01"),
            ],
            &current,
        );

        assert_eq!(
            actions,
            [
                ScheduleAction::Keep(current[0].clone()),
                ScheduleAction::Start { candidate: root("new", 3, "2024-01-01") },
            ]
        );
    }

    #[test]
    fn over_capacity_stops_the_lowest_priority_running_assignment() {
        let current = [
            CurrentAssignment { root_id: "low".into(), priority: 4 },
            CurrentAssignment { root_id: "urgent".into(), priority: 1 },
            CurrentAssignment { root_id: "high".into(), priority: 2 },
        ];

        let actions = schedule(&binding(2), &[], &current);

        assert_eq!(actions, [ScheduleAction::Stop { assignment: current[0].clone() }]);
    }

    #[test]
    fn conflicting_duplicate_candidates_choose_the_canonical_best_candidate() {
        let actions = schedule(
            &binding(1),
            &[
                root("duplicate", 4, "2024-01-01T00:00:00Z"),
                root("duplicate", 1, "2024-01-02T00:00:00Z"),
                root("duplicate", 1, "2024-01-01T00:00:00Z"),
            ],
            &[],
        );

        assert_eq!(
            actions,
            [ScheduleAction::Start { candidate: root("duplicate", 1, "2024-01-01T00:00:00Z") }]
        );
    }
}
