import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { api } from "../../api/client";
import type { SmokeCheckResult } from "../../api/types";
import { renderWithProviders } from "../../test/utils";
import { SmokeCheckStep } from "./SmokeCheckStep";

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      runSmokeCheck: vi.fn(),
      smokeCheckResult: vi.fn(),
    },
  };
});

const mockApi = api as unknown as {
  runSmokeCheck: ReturnType<typeof vi.fn>;
  smokeCheckResult: ReturnType<typeof vi.fn>;
};

function smokeResult(status: "running" | "passed"): SmokeCheckResult {
  const passed = status === "passed";
  return {
    smoke_check_id: "smoke-1",
    workspace_id: "workspace-1",
    revision: passed ? 2 : 1,
    status,
    checks: [{ name: "callback_acceptance", passed: true }],
    conductors: [
      {
        runtime_id: "runtime-1",
        runtime_group_id: "group-1",
        instance_id: "instance-1",
        binding_id: "binding-1",
        linear_project_id: "project-alpha",
        project_slug: "ALPHA",
        binding_config_version: 1,
        runtime_config_version: 1,
        repository: { mode: "local_path", value: "/repo" },
        expected_label: { id: "label-1", name: "symphony:conductor/Alpha-a1b2c3" },
        status,
        checks: passed ? [{ name: "binding_identity", passed: true }] : [],
        error_code: "",
        sanitized_reason: "",
        retryable: false,
        action_required: "",
        next_action: "",
        completed_at: passed ? "2026-07-10T00:00:01Z" : null,
      },
    ],
    recommendations: [],
    error_code: "",
    sanitized_reason: "",
    retryable: false,
    action_required: "",
    next_action: "",
    timestamp: "2026-07-10T00:00:00Z",
    completed_at: passed ? "2026-07-10T00:00:01Z" : null,
    expires_at: "2026-07-10T00:02:00Z",
  } as SmokeCheckResult;
}

describe("SmokeCheckStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats a newly started smoke check as running instead of failed", async () => {
    mockApi.smokeCheckResult.mockRejectedValue(new Error("not found"));
    mockApi.runSmokeCheck.mockResolvedValue(smokeResult("running"));

    renderWithProviders(
      <SmokeCheckStep
        stepNumber={5}
        stepCount={5}
        onBack={() => undefined}
        onNext={() => undefined}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Run smoke check" }));

    expect(await screen.findByText("Smoke check running")).toBeInTheDocument();
    expect(screen.queryByText("Smoke check found issues")).toBeNull();
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
  });

  it("polls a running smoke check until the final result arrives", async () => {
    mockApi.smokeCheckResult
      .mockResolvedValueOnce(smokeResult("running"))
      .mockResolvedValue(smokeResult("passed"));

    renderWithProviders(
      <SmokeCheckStep
        stepNumber={5}
        stepCount={5}
        onBack={() => undefined}
        onNext={() => undefined}
      />,
    );

    expect(await screen.findByText("Smoke check running")).toBeInTheDocument();
    expect(
      await screen.findByText("Everything checks out", {}, { timeout: 2500 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(mockApi.smokeCheckResult.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
