import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { App } from "../App";
import { createDemoState } from "../DesktopRuntime";

const confirmed = async () => ({ kind: "confirmed" as const });

test("navigation uses buttons and moves focus to each page heading", () => {
  render(<App initialState={createDemoState()} onCommand={confirmed} />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.getByRole("heading", { name: "Settings", level: 1 })).toHaveFocus();
  expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute("data-active", "true");
});

test("binding editor keeps all controls keyboard addressable", () => {
  render(<App initialState={createDemoState()} onCommand={confirmed} />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("button", { name: "New binding" }));
  expect(screen.getByRole("combobox", { name: "Linear Project" })).toBeVisible();
  expect(screen.getByRole("spinbutton", { name: "Concurrency" })).toHaveValue(1);
  expect(screen.getByRole("button", { name: "Save binding" })).toBeVisible();
});

test("binding editor is a modal dialog that closes on Escape", () => {
  render(<App initialState={createDemoState()} onCommand={confirmed} />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("button", { name: "New binding" }));
  expect(screen.getByRole("dialog", { name: "Create binding" })).toHaveAttribute("aria-modal", "true");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
