import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { SmokeCheckList } from "./SmokeCheckList";
import type { SmokeCheckResult } from "../api/types";
import { renderWithProviders } from "../test/utils";

describe("SmokeCheckList", () => {
  it("renders passing checks without an action", () => {
    const result: SmokeCheckResult = {
      status: "passed",
      checks: [
        { name: "linear_connection", passed: true },
        { name: "repository_mapping", passed: true },
        { name: "runtime_online", passed: true },
      ],
      recommendations: [],
      timestamp: "2026-07-02T00:00:00Z",
    };
    renderWithProviders(<SmokeCheckList result={result} />);

    expect(screen.getByText("Linear connected")).toBeInTheDocument();
    expect(screen.getByText("Runtime online")).toBeInTheDocument();
    expect(screen.queryByText(/Install and start a runtime/i)).toBeNull();
  });

  it("shows a recommended action for each failed check", () => {
    const result: SmokeCheckResult = {
      status: "failed",
      checks: [
        { name: "linear_connection", passed: true },
        { name: "repository_mapping", passed: false },
        { name: "runtime_online", passed: false },
      ],
      recommendations: ["Map a valid repository", "Enroll and start a runtime agent"],
      timestamp: "2026-07-02T00:00:00Z",
    };
    renderWithProviders(<SmokeCheckList result={result} />);

    expect(
      screen.getByText(/Map a valid repository in the Map repository step/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Install and start a runtime/i),
    ).toBeInTheDocument();
  });
});
