import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { App } from "./App";
import { connectedOverview, conductorDetail } from "./test/fixtures";

const defaults = {
  onCommand: async () => ({ kind: "confirmed" as const }),
  onSecret: async () => ({ kind: "confirmed" as const }),
  onChooseRepository: async () => undefined,
  onBeginCreateConductor: () => undefined,
  onSelectConductor: async () => undefined,
};

test("does not expose workflow navigation or workflow facts", () => {
  render(<App {...defaults} initialState={{ kind: "ready", overview: connectedOverview }} />);
  const navigation = screen.getByRole("navigation", { name: "Primary" });
  expect(within(navigation).getAllByRole("button").map((button) => button.textContent))
    .toEqual(["Overview", "Conductors", "Settings"]);
  expect(screen.queryByText(/Root|Work|Verify|Human Action|Next action/i)).not.toBeInTheDocument();
});

test("shows only Linear connection and Conductor presence in Overview", () => {
  render(<App {...defaults} initialState={{ kind: "ready", overview: connectedOverview }} />);
  expect(screen.getByTestId("linear-status")).toHaveTextContent("Connected");
  expect(screen.getByText("1 online")).toBeInTheDocument();
  expect(screen.getByText("A bounded runtime message")).toBeInTheDocument();
  expect(screen.queryByText(/token|approval|delivery|finding/i)).not.toBeInTheDocument();
});

test("keeps Profile controls available under Conductor configuration", () => {
  render(<App {...defaults} initialState={{
    kind: "ready",
    overview: connectedOverview,
    conductorDetail,
  }} />);
  fireEvent.click(screen.getByRole("button", { name: "Conductors" }));
  fireEvent.click(screen.getByRole("button", { name: /Studio conductor/ }));
  expect(screen.getByRole("heading", { name: "Performer Profiles" })).toBeInTheDocument();
  expect(screen.getByText(/Personal ChatGPT/)).toBeInTheDocument();
});

test("does not offer a Desktop approval or Root mutation", () => {
  const command = vi.fn().mockResolvedValue({ kind: "confirmed" });
  render(<App {...defaults} initialState={{ kind: "ready", overview: connectedOverview }} onCommand={command} />);
  expect(screen.queryByRole("button", { name: /approve|reject|cancel|create root/i })).not.toBeInTheDocument();
  expect(command).not.toHaveBeenCalled();
});
