import { render } from "@testing-library/react";
import { expect, test } from "vitest";

import { App } from "../App";
import { connectedOverview } from "../test/fixtures";
import { StatusBadge } from "./components";

const defaults = {
  onCommand: async () => ({ kind: "confirmed" as const }),
  onSecret: async () => ({ kind: "confirmed" as const }),
  onChooseRepository: async () => undefined,
  onBeginCreateConductor: () => undefined,
  onSelectConductor: async () => undefined,
};

// These tests pin the token-driven class structure of each screen so a
// stylesheet cleanup cannot silently drop or rename a class that
// layout.css still targets (or vice versa).

test("shell keeps the token-driven layout structure", () => {
  const { container } = render(
    <App {...defaults} initialState={{ kind: "ready", overview: connectedOverview }} />,
  );
  expect(container.querySelector(".app > .sidebar")).not.toBeNull();
  expect(container.querySelector(".drag-region")).not.toBeNull();
  expect(container.querySelector(".brand > .brand-mark")).not.toBeNull();
  expect(container.querySelector(".app > .main")).not.toBeNull();
  const links = container.querySelectorAll(".nav > .nav-link");
  expect(links).toHaveLength(3);
  expect(links[0]).toHaveAttribute("data-active", "true");
  expect(links[1]).toHaveAttribute("data-active", "false");
});

test("overview keeps panel, readiness, and list classes", () => {
  const { container } = render(
    <App {...defaults} initialState={{ kind: "ready", overview: connectedOverview }} />,
  );
  expect(container.querySelector(".page-header")).not.toBeNull();
  expect(container.querySelectorAll(".page-stack > .panel")).toHaveLength(2);
  expect(container.querySelector(".section-heading")).not.toBeNull();
  expect(container.querySelector(".readiness-list")).not.toBeNull();
  expect(
    container.querySelector('.status-badge[data-tone="positive"] .status-dot'),
  ).not.toBeNull();
  expect(container.querySelector(".plain-list > li > strong")).not.toBeNull();
  expect(container.querySelector(".plain-list .mono")).not.toBeNull();
  expect(container.querySelector(".refresh-value")).not.toBeNull();
});

test("setup and fallback screens keep their card structure", () => {
  const { container: setup } = render(
    <App {...defaults} initialState={{ kind: "linear-setup" }} />,
  );
  expect(setup.querySelector(".setup-layout > .setup-card")).not.toBeNull();
  expect(setup.querySelector(".eyebrow")).not.toBeNull();
  expect(setup.querySelector(".button.primary.full-width")).not.toBeNull();
  expect(setup.querySelector(".brand-mark-animated .brand-mark-path")).not.toBeNull();
  expect(setup.querySelector(".setup-progress-fill")).toHaveAttribute("data-step", "1");
  expect(setup.querySelector(".setup-card > .setup-card-body")).not.toBeNull();

  const { container: unavailable } = render(
    <App
      {...defaults}
      initialState={{ kind: "unavailable", summary: "s", nextAction: "n" }}
    />,
  );
  expect(unavailable.querySelector(".setup-card.error-panel")).not.toBeNull();

  const { container: loading } = render(
    <App {...defaults} initialState={{ kind: "loading", objectLabel: "Desktop state" }} />,
  );
  expect(loading.querySelector(".setup-card.skeleton")).not.toBeNull();
});

test("status badge passes tone through data attributes", () => {
  const { container } = render(<StatusBadge label="Linear" tone="warning" />);
  expect(container.querySelector('.status-badge[data-tone="warning"]')).not.toBeNull();
});
