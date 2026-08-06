import { expect, test } from "vitest";

import { createDemoState, MemoryDesktopHost } from "./DesktopRuntime";

test("demo state is root-centric and carries binding retention", () => {
  const state = createDemoState();
  expect(state.overview.roots.length).toBeGreaterThan(0);
  expect(state.overview.bindings.some((binding) => binding.completedWorkspaceRetention !== undefined)).toBe(true);
  expect(JSON.stringify(state)).not.toContain("workspace_path");
  expect(JSON.stringify(state)).not.toContain("run_directory");
  expect(JSON.stringify(state)).not.toContain("slot");
});

test("memory host fails unavailable RootActions explicitly", async () => {
  const result = await new MemoryDesktopHost().execute({ kind: "cleanup_workspace", rootId: "root-101" });
  expect(result).toEqual({
    kind: "rejected",
    sanitizedReason: "root_cleanup_workspace_unavailable",
  });
});

test("memory host exposes selectable Projects for the first-binding flow", async () => {
  const result = await new MemoryDesktopHost().execute({ kind: "list_linear_projects" });
  expect(result.kind).toBe("projects");
  if (result.kind !== "projects") return;
  expect(result.projects).toContainEqual({ id: "project-new", name: "Unbound demo project" });
});
