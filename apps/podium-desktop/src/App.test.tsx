import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { App } from "./App";
import { createDemoState } from "./DesktopRuntime";

const confirmed = async () => ({ kind: "confirmed" as const });

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

test("overview renders more than one binding and multiple slots", () => {
  render(<App initialState={createDemoState()} onCommand={confirmed} />);
  expect(screen.getByRole("heading", { name: "Project Bindings" })).toBeInTheDocument();
  expect(screen.getAllByText("Symphony").length).toBeGreaterThan(0);
  expect(screen.getByText("Operator Console")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Root assignments" })).toBeInTheDocument();
  expect(screen.getAllByText(/SYM-101/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/OPS-201/).length).toBeGreaterThan(0);
});

test("settings saves a flattened binding with optional role fields", async () => {
  const command = vi.fn().mockImplementation(confirmed);
  render(<App initialState={createDemoState()} onCommand={command} />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("button", { name: "New binding" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Project ID" }), { target: { value: "project-new" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "New Project" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Routing label" }), { target: { value: "new" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Repository path" }), { target: { value: "~/Code/new" } });
  fireEvent.click(screen.getByRole("button", { name: "Save binding" }));
  expect(command).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "create_binding",
      binding: expect.objectContaining({
        projectId: "project-new",
        reconcile_agent: "codex",
        execute_agent: "codex",
        audit_agent: "codex",
        reconcile_model: null,
        execute_reasoning_effort: null,
      }),
    }),
  );
});

test("conductors exposes binding and Root assignment controls", () => {
  const command = vi.fn().mockImplementation(confirmed);
  render(<App initialState={createDemoState()} onCommand={command} />);
  fireEvent.click(screen.getByRole("button", { name: "Conductors" }));
  expect(screen.getByRole("heading", { name: "Project Bindings" })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /Start|Stop/ }).length).toBeGreaterThan(2);
  fireEvent.click(screen.getAllByRole("button", { name: "Stop binding" })[0]!);
  expect(command).toHaveBeenCalledWith({ kind: "stop_binding", bindingId: "binding-symphony" });
});
