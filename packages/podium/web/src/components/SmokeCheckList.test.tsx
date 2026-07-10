import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { SmokeCheckList } from "./SmokeCheckList";
import type { SmokeCheckResult } from "../api/types";
import { renderWithProviders } from "../test/utils";

function smokeResult(overrides: Partial<SmokeCheckResult>): SmokeCheckResult {
  return {
    smoke_check_id: "smoke-1",
    workspace_id: "workspace-1",
    revision: 1,
    status: "passed",
    checks: [],
    conductors: [],
    recommendations: [],
    error_code: "",
    sanitized_reason: "",
    retryable: false,
    action_required: "",
    next_action: "",
    timestamp: "2026-07-10T00:00:00Z",
    completed_at: "2026-07-10T00:00:01Z",
    expires_at: "2026-07-10T00:02:00Z",
    ...overrides,
  };
}

describe("SmokeCheckList", () => {
  it("renders passing checks without an action", () => {
    const result = smokeResult({
      checks: [
        { name: "callback_acceptance", passed: true },
        { name: "ready_bindings", passed: true },
        { name: "runtime_connectivity", passed: true },
      ],
    });
    renderWithProviders(<SmokeCheckList result={result} />);

    expect(screen.getByText("OAuth callback accepted")).toBeInTheDocument();
    expect(screen.getByText("Conductor connectivity")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Passed")).toHaveLength(3);
    expect(screen.queryByText(/Start the bound Conductor/i)).toBeNull();
  });

  it("shows a recommended action for each failed check", () => {
    const result = smokeResult({
      status: "failed",
      checks: [
        { name: "callback_acceptance", passed: true },
        { name: "selected_project_access", passed: false },
        { name: "runtime_connectivity", passed: false },
      ],
      error_code: "smoke_prerequisites_failed",
      sanitized_reason: "Smoke check prerequisites are not ready",
      retryable: true,
      action_required: "fix_smoke_prerequisites",
    });
    renderWithProviders(<SmokeCheckList result={result} />);

    expect(
      screen.getByText(/Review selected projects and application access/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Start the bound Conductor and wait for its report/i),
    ).toBeInTheDocument();
  });

  it("shows a running Conductor while its checks are pending", () => {
    const result = smokeResult({
      status: "running",
      checks: [{ name: "ready_bindings", passed: true }],
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
          status: "running",
          checks: [],
          error_code: "",
          sanitized_reason: "",
          retryable: false,
          action_required: "",
          next_action: "",
          completed_at: null,
        },
      ],
      completed_at: null,
    });

    renderWithProviders(<SmokeCheckList result={result} />);

    expect(screen.getByText("ALPHA Conductor")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Waiting for Conductor result.")).toBeInTheDocument();
  });

  it("shows Conductor-level checks and sanitized failure details", () => {
    const result = smokeResult({
      status: "failed",
      checks: [{ name: "ready_bindings", passed: true }],
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
          status: "failed",
          checks: [
            { name: "binding_identity", passed: true },
            { name: "project_label_state", passed: false },
          ],
          error_code: "managed_project_label_mismatch",
          sanitized_reason: "Managed project label is missing",
          retryable: true,
          action_required: "restore_project_label",
          next_action: "rerun_smoke_check",
          completed_at: "2026-07-10T00:00:01Z",
        },
      ],
      error_code: "smoke_check_failed",
      sanitized_reason: "One or more Conductor smoke checks failed",
      retryable: true,
      action_required: "fix_failed_smoke_checks",
    });

    renderWithProviders(<SmokeCheckList result={result} />);

    expect(screen.getByText("Binding identity")).toBeInTheDocument();
    expect(screen.getByText("Project label installed")).toBeInTheDocument();
    expect(screen.getByText("managed_project_label_mismatch")).toBeInTheDocument();
    expect(screen.getByText("Managed project label is missing")).toBeInTheDocument();
    expect(screen.getByText(/Restore project label/)).toBeInTheDocument();
  });
});
