import { decodePodiumClientDesktopOverviewView } from "../contracts-runtime.mjs";

import type {
  DesktopOverviewInput,
  DesktopOverviewView,
  DesktopViewInterface,
  JsonValue,
  NextActionView,
} from "../../public/DesktopViewInterface.js";

export class PodiumDesktopViewImpl implements DesktopViewInterface {
  constructor(private readonly options: { staleAfterMs: number }) {}

  overview(input: DesktopOverviewInput): DesktopOverviewView {
    const nextAction = selectNextAction(input);
    const view = {
      ...(nextAction ? { next_action: nextAction } : {}),
      linear_connection: input.linear_connection,
      conductors: input.conductors,
      active_roots: input.active_nodes,
      review_roots: input.review_roots.map((root) => ({
        root_issue_id: root.root_issue_id,
        identifier: root.identifier,
        title: root.title,
        status: root.status,
        ...(root.current_node_summary
          ? { current_node_summary: root.current_node_summary }
          : {}),
        ...(root.linear_url ? { linear_url: root.linear_url } : {}),
        observed_at: root.observed_at,
      })),
      recent_problems: input.problems,
      usage: {
        ...input.usage,
        completed_root_count: input.completed_root_count,
        is_stale:
          Date.parse(input.now) - Date.parse(input.usage.observed_at) >
          this.options.staleAfterMs,
      },
      observed_at: input.now,
    };
    return decodePodiumClientDesktopOverviewView(view) as JsonValue;
  }
}

function selectNextAction(input: DesktopOverviewInput): NextActionView | undefined {
  if (input.linear_connection.status !== "connected") {
    return action(
      "reconnect_linear",
      "Reconnect Linear",
      "Symphony cannot read or update work.",
      "Reconnect",
    );
  }
  const projectConflict = input.conductors.find(
    ({ status }) => status === "project_conflict",
  );
  if (projectConflict) {
    return action(
      "resolve_conductor_project_conflict",
      "Resolve the Conductor Project conflict",
      `${projectConflict.display_name} cannot select a unique Linear Project.`,
      "View Conductor",
    );
  }
  const stopped = input.conductors.find(({ status }) => status === "stopped");
  if (stopped) {
    return action(
      "start_stopped_conductor",
      "Start the stopped Conductor",
      `${stopped.display_name} is not processing delegated work.`,
      "View Conductor",
    );
  }
  if (input.profiles.length === 0) {
    return action(
      "configure_codex_profile",
      "Configure a Codex Profile",
      "Performer Turns cannot start without a Profile.",
      "Configure Profile",
    );
  }
  const active = input.profiles.find(({ is_active }) => is_active);
  if (active && active.readiness !== "ready") {
    return action(
      "sign_in_active_profile",
      "Sign in to the active Codex Profile",
      "New Performer Turns cannot start.",
      "Configure Profile",
    );
  }
  if (!active) {
    return action(
      "choose_active_profile",
      "Choose an active Performer Profile",
      "New Roots cannot start.",
      "View Conductor",
    );
  }
  for (const kind of [
    "approve_plan",
    "answer_human_node",
    "repair_blocked_root",
  ]) {
    const nextAction = input.problems.find(
      ({ next_action: candidate }) => candidate?.kind === kind,
    )?.next_action;
    if (nextAction) return nextAction;
  }
  const reviewRoot = input.review_roots[0];
  if (reviewRoot) {
    return action(
      "review_delivered_root",
      `Review ${reviewRoot.identifier} in Linear`,
      "Symphony delivered the Root and is waiting for your review.",
      "Open in Linear",
      reviewRoot.linear_url,
    );
  }
  return undefined;
}

function action(
  kind: string,
  summary: string,
  impact: string,
  actionLabel: string,
  linearUrl?: string,
): NextActionView {
  return {
    kind,
    summary,
    impact,
    action_label: actionLabel,
    ...(linearUrl ? { linear_url: linearUrl } : {}),
  };
}
