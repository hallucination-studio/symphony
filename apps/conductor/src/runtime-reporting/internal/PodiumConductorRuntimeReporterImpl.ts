import type { ConductorRuntimeReporterInterface, RuntimeProblemInput } from "../api/ConductorRuntimeReporterInterface.js";

type JsonValue = null | boolean | number | string | JsonValue[] |
  { [key: string]: JsonValue };

export class PodiumConductorRuntimeReporterImpl implements ConductorRuntimeReporterInterface {
  constructor(private readonly options: {
    bindingId: string;
    instanceId: string;
    now(): string;
    send(body: JsonValue): Promise<void>;
  }) {}

  async report(input: {
    status: "ready" | "blocked";
    sanitizedReason?: string;
    rootId?: string;
  }): Promise<void> {
    if (input.status === "blocked") {
      await this.problem({
        code: "conductor_cycle_blocked",
        scope: input.rootId ? "root" : "binding",
        severity: "error",
        reason: input.sanitizedReason ?? "Conductor cycle blocked.",
        ...(input.rootId ? { rootIssueId: input.rootId } : {}),
        actionRequired: "Inspect current Linear and Git facts before retrying.",
      });
      return;
    }
    await this.options.send({
      kind: "conductor_runtime_report", binding_id: this.options.bindingId,
      instance_id: this.options.instanceId, status: "ready",
      ...(input.rootId ? { active_root_issue_id: input.rootId } : {}),
      observed_at: this.options.now(),
    });
  }

  async problem(input: RuntimeProblemInput): Promise<void> {
    const observedAt = this.options.now();
    const reason = sanitize(input.reason);
    await this.options.send({
      kind: "conductor_runtime_report",
      binding_id: this.options.bindingId,
      instance_id: this.options.instanceId,
      status: "recovering",
      ...(input.rootIssueId ? { active_root_issue_id: input.rootIssueId } : {}),
      sanitized_summary: reason,
      observed_at: observedAt,
      runtime_problem: {
        code: closedIdentifier(input.code), scope: input.scope, severity: input.severity,
        sanitized_reason: reason,
        ...(input.actionRequired ? { action_required: sanitize(input.actionRequired) } : {}),
        first_observed_at: observedAt, last_observed_at: observedAt,
        ...(input.rootIssueId ? { root_issue_id: input.rootIssueId } : {}),
        ...(input.turnId ? { turn_id: input.turnId } : {}),
        ...(input.performerProfileId
          ? { performer_profile_id: input.performerProfileId } : {}),
      },
    });
  }
}

function sanitize(value: string): string {
  return value
    .replace(/(?:Authorization:\s*Bearer|Bearer)\s+[A-Za-z0-9._-]+/gi, "Authorization: [REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\s+/g, " ").trim().slice(0, 2048);
}

function closedIdentifier(value: string): string {
  return /^[a-z][a-z0-9_]{0,127}$/.test(value) ? value : "runtime_problem";
}
