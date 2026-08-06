import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { App } from "./App";
import { createDemoState } from "./DesktopRuntime";

const confirmed = async () => ({ kind: "confirmed" as const });

const projectList = {
  kind: "projects" as const,
  projects: [
    { id: "project-symphony", name: "Symphony" },
    { id: "project-console", name: "Console" },
    { id: "project-new", name: "New project" },
  ],
};

const confirmedWithProjects = async (command: { kind: string }) =>
  command.kind === "list_linear_projects" ? projectList : confirmed();

test("keeps the desktop information architecture to three pages", () => {
  render(<App initialState={createDemoState()} onCommand={confirmed} />);
  const navigation = screen.getByRole("navigation", { name: "Primary" });
  expect(within(navigation).getAllByRole("button").map((button) => button.textContent)).toEqual([
    "Overview",
    "Conductors",
    "Settings",
  ]);
  expect(screen.queryByText(/Performer|ChatGPT|API Key|sandbox|allowlist|daemon|NeedsHuman/i)).not.toBeInTheDocument();
});

test("overview renders bindings and Roots grouped by operator state", () => {
  render(<App initialState={createDemoState()} onCommand={confirmed} />);
  expect(screen.getByRole("heading", { name: "Project Bindings" })).toBeInTheDocument();
  expect(screen.getAllByText("project-symphony").length).toBeGreaterThan(0);
  expect(screen.getByText("project-console")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Running" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Waiting" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Needs attention" })).toBeInTheDocument();
  expect(screen.getAllByText(/SYM-101/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/OPS-201/).length).toBeGreaterThan(0);
});

test("Root rows expose only available actions and require confirmation for cleanup", async () => {
  const command = vi.fn().mockImplementation(confirmed);
  const state = createDemoState();
  state.overview.roots[0]!.actions = [
    { kind: "open_workspace", available: true },
    { kind: "open_linear", available: false, reason: "not available" },
    { kind: "cleanup_workspace", available: true },
  ];

  render(<App initialState={state} onCommand={command} />);

  expect(screen.getByRole("button", { name: "Open workspace" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Clean up workspace" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open Linear" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: "open_workspace", rootId: "root-101" }));

  fireEvent.click(screen.getByRole("button", { name: "Clean up workspace" }));
  expect(command).toHaveBeenCalledTimes(1);
  const confirmation = screen.getByRole("dialog", { name: "Clean up this Root workspace?" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Clean up workspace" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: "cleanup_workspace", rootId: "root-101" }));
});

test("settings saves a flattened binding with optional role fields", async () => {
  const command = vi.fn().mockImplementation(confirmedWithProjects);
  render(<App initialState={createDemoState()} onCommand={command} />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("button", { name: "New binding" }));
  await screen.findByRole("option", { name: "New project" });
  fireEvent.change(screen.getByRole("combobox", { name: "Linear Project" }), { target: { value: "project-new" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Routing label" }), { target: { value: "new" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Repository path" }), { target: { value: "~/Code/new" } });
  fireEvent.click(screen.getByRole("button", { name: "Save binding" }));
  expect(command).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "create_binding",
      binding: expect.objectContaining({
        projectId: "project-new",
        reconcile_agent: "codex",
        artist_agent: "codex",
        critic_agent: "codex",
        reconcile_model: null,
        artist_reasoning_effort: null,
      }),
    }),
  );
});

test("settings edit keeps artist and critic role overrides", async () => {
  const command = vi.fn().mockImplementation(confirmedWithProjects);
  render(<App initialState={createDemoState()} onCommand={command} />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Edit binding" })[0]!);
  await screen.findByRole("option", { name: "Symphony" });
  const artist = within(screen.getByRole("group", { name: "Artist launch" }));
  fireEvent.change(artist.getByRole("textbox", { name: "Model override" }), {
    target: { value: "gpt-5-artist" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save binding" }));
  await screen.findByRole("status");
  expect(command).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "update_binding",
      binding: expect.objectContaining({
        id: "project-symphony",
        artist_model: "gpt-5-artist",
        artist_reasoning_effort: "high",
        critic_model: null,
      }),
    }),
  );
});

test("settings delete asks for confirmation in a dialog", async () => {
  const command = vi.fn().mockImplementation(confirmed);
  const nativeConfirm = vi.spyOn(window, "confirm");
  render(<App initialState={createDemoState()} onCommand={command} />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Edit binding" })[0]!);
  fireEvent.click(screen.getByRole("button", { name: "Delete binding" }));
  const confirmation = screen.getByRole("dialog", { name: "Delete this Project Binding?" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));
  await screen.findByRole("status");
  expect(command).toHaveBeenCalledWith({ kind: "delete_binding", bindingId: "project-symphony" });
  expect(nativeConfirm).not.toHaveBeenCalled();
  nativeConfirm.mockRestore();
});

test("settings blocks save until required fields are filled", () => {
  const command = vi.fn().mockImplementation(confirmed);
  render(<App initialState={createDemoState()} onCommand={command} />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("button", { name: "New binding" }));
  fireEvent.click(screen.getByRole("button", { name: "Save binding" }));
  expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "create_binding" }));
  expect(screen.getByText("Select a Linear project.")).toBeInTheDocument();
  expect(screen.getByText("Repository path is required.")).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Linear Project" })).toHaveAttribute("aria-invalid", "true");
});

test("conductors exposes binding controls while assignments stay scheduler-owned", () => {
  const command = vi.fn().mockImplementation(confirmed);
  render(<App initialState={createDemoState()} onCommand={command} />);
  fireEvent.click(screen.getByRole("button", { name: "Conductors" }));
  expect(screen.getByRole("heading", { name: "Project Bindings" })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /Start binding|Stop binding/ })).toHaveLength(2);
  expect(screen.queryByRole("button", { name: /assignment/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: "Stop binding" })[0]!);
  expect(command).toHaveBeenCalledWith({ kind: "stop_binding", bindingId: "project-symphony" });
});
