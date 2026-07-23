import { expect, test } from "vitest";

import { decodeDesktopOverviewView } from "./GeneratedPodiumClient";

test("validates the closed control-plane overview before mapping wire names", async () => {
  const view = await decodeDesktopOverviewView({
    linear_connection: {
      status: "connected",
      workspace_name: "Acme",
      observed_at: "2026-07-16T09:45:00+08:00",
    },
    projects: [],
    conductors: [],
    recent_logs: [],
    observed_at: "2026-07-16T09:45:00+08:00",
  }) as { linearConnection: { workspaceName?: string } };
  expect(view.linearConnection.workspaceName).toBe("Acme");
});

test("rejects workflow and secret fields at the browser contract", async () => {
  await expect(decodeDesktopOverviewView({
    linear_connection: { status: "connected", observed_at: "2026-07-16T09:45:00+08:00" },
    projects: [],
    conductors: [],
    recent_logs: [],
    observed_at: "2026-07-16T09:45:00+08:00",
    next_action: { kind: "approve_plan" },
  })).rejects.toThrow();
});
