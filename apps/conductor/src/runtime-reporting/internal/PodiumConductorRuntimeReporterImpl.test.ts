import assert from "node:assert/strict";
import test from "node:test";

import { PodiumConductorRuntimeReporterImpl } from "./PodiumConductorRuntimeReporterImpl.js";

test("Runtime Problem is correlated, bounded, and strips credentials", async () => {
  const sent: unknown[] = [];
  const reporter = new PodiumConductorRuntimeReporterImpl({
    bindingId: "binding-1", instanceId: "instance-1",
    now: () => "2026-07-19T00:00:00Z",
    send: async (body) => { sent.push(body); },
  });

  await reporter.problem({
    code: "linear_rate_limited", scope: "stage", severity: "error",
    reason: "Authorization: Bearer secret-token failed for sk-secret",
    rootIssueId: "root-1", performerProfileId: "profile-1",
    actionRequired: "Retry after Linear recovers.",
  });

  assert.deepEqual(sent, [{
    kind: "conductor_runtime_report", binding_id: "binding-1", instance_id: "instance-1",
    status: "recovering", active_root_issue_id: "root-1",
    sanitized_summary: "Authorization: [REDACTED] failed for [REDACTED]",
    observed_at: "2026-07-19T00:00:00Z",
    runtime_problem: {
      code: "linear_rate_limited", scope: "stage", severity: "error",
      sanitized_reason: "Authorization: [REDACTED] failed for [REDACTED]",
      action_required: "Retry after Linear recovers.",
      first_observed_at: "2026-07-19T00:00:00Z",
      last_observed_at: "2026-07-19T00:00:00Z",
      root_issue_id: "root-1", performer_profile_id: "profile-1",
    },
  }]);
});
