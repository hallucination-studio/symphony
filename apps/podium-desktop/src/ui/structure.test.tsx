import { render } from "@testing-library/react";
import { expect, test } from "vitest";

import { App } from "../App";
import { createDemoState } from "../DesktopRuntime";
import { StatusBadge } from "./components";

const confirmed = async () => ({ kind: "confirmed" as const });

test("shell keeps the three-page layout structure", () => {
  const { container } = render(<App initialState={createDemoState()} onCommand={confirmed} />);
  expect(container.querySelector(".app > .sidebar")).not.toBeNull();
  expect(container.querySelector(".drag-region")).not.toBeNull();
  expect(container.querySelector(".brand > .brand-mark")).not.toBeNull();
  expect(container.querySelector(".app > .main")).not.toBeNull();
  expect(container.querySelectorAll(".nav > .nav-link")).toHaveLength(3);
});

test("overview keeps grouped panels and assignment lists", () => {
  const { container } = render(<App initialState={createDemoState()} onCommand={confirmed} />);
  expect(container.querySelector(".page-header")).not.toBeNull();
  expect(container.querySelectorAll(".page-stack > .panel")).toHaveLength(3);
  expect(container.querySelector(".readiness-list")).not.toBeNull();
  expect(container.querySelector(".plain-list")).not.toBeNull();
  expect(container.querySelector(".status-badge")).not.toBeNull();
});

test("status badge pairs tone with a text label", () => {
  const { container } = render(<StatusBadge label="Terminal" tone="neutral" />);
  const badge = container.querySelector('.status-badge[data-tone="neutral"]');
  expect(badge).not.toBeNull();
  expect(badge).toHaveTextContent("Terminal");
  expect(badge?.querySelector(".status-dot")).toHaveAttribute("aria-hidden", "true");
});
