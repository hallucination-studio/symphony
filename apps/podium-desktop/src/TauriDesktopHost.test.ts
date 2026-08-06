import { beforeEach, expect, test, vi } from "vitest";

const { invokeMock, openMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));

import { TauriDesktopHost } from "./TauriDesktopHost";

beforeEach(() => {
  invokeMock.mockReset();
  openMock.mockReset();
});

test("maps a root-centric snapshot without forwarding derived resource paths or slot data", async () => {
  invokeMock.mockResolvedValue({
    bindings: [
      {
        project_id: "project-1",
        routing_label: "core",
        repository_path: "/private/repository",
        base_branch: "main",
        concurrency: 2,
        completed_workspace_retention: 3,
        reconcile_agent: "codex",
        artist_agent: "codex",
        critic_agent: "codex",
      },
    ],
    roots: [
      {
        root_id: "root-1",
        binding_id: "project-1",
        identifier: "ENG-1",
        title: "Improve routing",
        priority: 2,
        status: "running",
        latest_event: "Conductor started",
        queue_position: null,
        observed_at: "2026-08-06T00:00:00.000Z",
        actions: [
          { kind: "open_linear", available: false, reason: "root_open_linear_unavailable" },
          { kind: "cleanup_workspace", available: false, reason: "root_cleanup_workspace_unavailable" },
        ],
      },
    ],
    events: [],
    linear: { status: "disconnected" },
  });

  const state = await new TauriDesktopHost().getState();
  expect(state.kind).toBe("ready");
  if (state.kind !== "ready") return;
  expect(state.overview.bindings[0]?.completedWorkspaceRetention).toBe(3);
  expect(state.overview.roots).toHaveLength(1);
  expect(state.overview.roots[0]).toMatchObject({
    rootId: "root-1",
    bindingId: "project-1",
    status: "running",
    latestEvent: "Conductor started",
    queuePosition: null,
  });
  expect(state.overview.bindings[0]?.repositoryPath).toBe("/private/repository");
  expect(state.overview.linear).toEqual({ status: "disconnected" });
  expect(JSON.stringify(state)).not.toContain("workspace_path");
  expect(JSON.stringify(state)).not.toContain("run_directory");
  expect(JSON.stringify(state)).not.toContain("slot");
});

test("dispatches every closed RootAction to its native command", async () => {
  invokeMock.mockResolvedValue(undefined);
  const host = new TauriDesktopHost();
  const commands = [
    ["open_linear", "open_linear"],
    ["open_workspace", "open_workspace"],
    ["open_delivery", "open_delivery"],
    ["open_diagnostics", "open_diagnostics"],
    ["cleanup_workspace", "cleanup_workspace"],
  ] as const;

  for (const [kind, commandName] of commands) {
    await expect(host.execute({ kind, rootId: "root-1" })).resolves.toEqual({ kind: "confirmed" });
    expect(invokeMock).toHaveBeenLastCalledWith(commandName, { rootId: "root-1" });
  }
});

test("uses the native Linear connection and project-list boundaries", async () => {
  invokeMock.mockImplementation(async (commandName: string) => {
    if (commandName === "list_linear_projects") {
      return [{ id: "project-1", name: "Symphony" }];
    }
    return { status: "connected", organization: "Acme" };
  });
  const host = new TauriDesktopHost();

  await expect(host.execute({ kind: "connect_linear" })).resolves.toEqual({ kind: "confirmed" });
  expect(invokeMock).toHaveBeenLastCalledWith("connect_linear");
  await expect(host.execute({ kind: "list_linear_projects" })).resolves.toEqual({
    kind: "projects",
    projects: [{ id: "project-1", name: "Symphony" }],
  });
  expect(invokeMock).toHaveBeenLastCalledWith("list_linear_projects");
  await expect(host.execute({ kind: "disconnect_linear" })).resolves.toEqual({ kind: "confirmed" });
  expect(invokeMock).toHaveBeenLastCalledWith("disconnect_linear");
});

test("rejects malformed native project lists instead of inventing options", async () => {
  invokeMock.mockResolvedValue([{ id: "project-1" }]);
  await expect(new TauriDesktopHost().execute({ kind: "list_linear_projects" })).resolves.toEqual({
    kind: "rejected",
    sanitizedReason: "linear_projects_invalid",
  });
});

test("preserves bounded native action errors as actionable command failures", async () => {
  invokeMock.mockRejectedValue("root_cleanup_workspace_unavailable");
  await expect(new TauriDesktopHost().execute({ kind: "cleanup_workspace", rootId: "root-1" })).resolves.toEqual({
    kind: "rejected",
    sanitizedReason: "root_cleanup_workspace_unavailable",
  });
});
