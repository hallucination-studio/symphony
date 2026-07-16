import { expect, test } from "vitest";

import {
  decodeDesktopOverviewView,
  decodeRootDetailView,
} from "./GeneratedPodiumClient";

test("validates a closed generated view before mapping wire field names", async () => {
  const view = await decodeDesktopOverviewView({
    linear_connection: {
      status: "connected",
      workspace_name: "Acme",
      observed_at: "2026-07-16T09:45:00+08:00",
    },
    conductors: [],
    active_roots: [],
    review_roots: [],
    recent_problems: [],
    usage: {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
      completed_root_count: 0,
      observed_at: "2026-07-16T09:45:00+08:00",
      is_stale: false,
    },
    observed_at: "2026-07-16T09:45:00+08:00",
  });

  expect(view.linearConnection.workspaceName).toBe("Acme");
  expect(view.usage.totalTokens).toBe(0);
});

test("rejects unknown browser-facing fields", async () => {
  await expect(
    decodeDesktopOverviewView({
      linear_connection: {
        status: "connected",
        observed_at: "2026-07-16T09:45:00+08:00",
      },
      conductors: [],
      active_roots: [],
      review_roots: [],
      recent_problems: [],
      usage: {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
        completed_root_count: 0,
        observed_at: "2026-07-16T09:45:00+08:00",
        is_stale: false,
      },
      observed_at: "2026-07-16T09:45:00+08:00",
      access_token: "forbidden",
    }),
  ).rejects.toThrow();
});

test("validates workflow nodes with their generated closed contract", async () => {
  const observedAt = "2026-07-16T09:45:00+08:00";
  const view = await decodeRootDetailView({
    summary: {
      root_issue_id: "root-1",
      identifier: "SYM-1",
      title: "Root",
      status: "Working",
      observed_at: observedAt,
    },
    workflow_nodes: [
      {
        issue_id: "work-1",
        kind: "work_leaf",
        state: "Todo",
        order: 1,
        depth: 0,
        title: "Work",
        is_canceled: false,
      },
    ],
    usage: {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
      completed_root_count: 0,
      observed_at: observedAt,
      is_stale: false,
    },
    events: [],
  });

  expect(view.workflowNodes[0]?.kind).toBe("work_leaf");
});
