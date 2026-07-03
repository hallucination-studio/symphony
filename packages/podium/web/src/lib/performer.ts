// Presentation helpers for Performers (the backend "bindings").
//
// A Performer is one project-scoped execution unit a Conductor operates. These
// helpers turn a raw binding into the constraint chips, health, and queue
// metrics the Runtimes view renders — so the "what does this Performer do"
// story reads in one glance.

import type { ConductorBinding, InstanceLogLine } from "../api/types";
import type { GlobalStatus } from "./format";

export interface PerformerConstraint {
  label: string;
  value: string;
}

/**
 * The scoping rules that decide which Linear issues this Performer runs:
 * its project, the custom-agent delegate, and the workflow profile. These are
 * exactly the constraints Conductor mirrors onto the Linear project as labels.
 */
export function performerConstraints(binding: ConductorBinding): PerformerConstraint[] {
  const constraints: PerformerConstraint[] = [];
  const project = binding.project_slug || binding.linear_project;
  constraints.push({ label: "Project", value: project || "unscoped" });
  constraints.push({
    label: "Delegate",
    value: binding.agent_app_user_id || "none",
  });
  constraints.push({
    label: "Profile",
    value: binding.workflow_profile || "task",
  });
  return constraints;
}

/**
 * A Performer is only routable when it is scoped to a project AND bound to a
 * custom-agent delegate — dispatch matches on both. Missing either means it
 * will never receive work, which we surface as "degraded".
 */
export function performerIsScoped(binding: ConductorBinding): boolean {
  const project = binding.project_slug || binding.linear_project;
  return Boolean(project && binding.agent_app_user_id);
}

/** Map the Conductor process status onto the shared badge vocabulary. */
export function performerStatus(binding: ConductorBinding): GlobalStatus {
  switch (binding.process_status) {
    case "running":
      return "running";
    case "starting":
      return "pending";
    case "unhealthy":
    case "crash_loop":
      return "failed";
    case "stopped":
    case "exited":
      return "offline";
    default:
      return "not_started";
  }
}

export interface PerformerMetric {
  label: string;
  value: number;
  tone?: "negative";
}

/**
 * The queue + throughput numbers for a Performer, ordered so the operational
 * signals (queue depth, blocked, failures) lead. Zero values still render so
 * the row shape stays stable across Performers.
 */
export function performerMetrics(binding: ConductorBinding): PerformerMetric[] {
  const metrics = binding.metrics ?? {};
  const queueDepth = binding.queue?.queue_depth ?? metrics.queue_depth ?? 0;
  return [
    { label: "Queued", value: queueDepth },
    { label: "Retries", value: metrics.retries ?? 0 },
    { label: "Blocked", value: metrics.blocked ?? 0, tone: "negative" },
    { label: "Failures", value: metrics.failures ?? 0, tone: "negative" },
    { label: "Tokens", value: metrics.tokens ?? 0 },
  ];
}

export function performerIsRunning(binding: ConductorBinding): boolean {
  return Boolean(binding.queue?.running ?? binding.metrics?.running) || binding.process_status === "running";
}

/** Normalize a log line (plain string or structured) to display text. */
export function logLineText(line: InstanceLogLine): string {
  if (typeof line === "string") return line;
  return line.text ?? line.message ?? line.line ?? "";
}
