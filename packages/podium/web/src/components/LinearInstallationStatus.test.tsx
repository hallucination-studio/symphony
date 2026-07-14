import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LinearInstallation, LinearInstallations } from "../api/types";
import { renderWithProviders } from "../test/utils";
import { LinearInstallationStatus } from "./LinearInstallationStatus";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function installation(overrides: Partial<LinearInstallation> = {}): LinearInstallation {
  return {
    id: "installation-1",
    state: "ready",
    actor: "app",
    organization_name: "Acme",
    app_user_id: "app-user-1",
    scope: ["read", "write"],
    reconciliation_state: "healthy",
    ...overrides,
  };
}

function installations(overrides: Partial<LinearInstallations> = {}): LinearInstallations {
  return { active: installation(), candidate: null, revocation: null, ...overrides };
}

function mockFetch(status: number, body: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response);
}

it("renders pending reconciliation as Pending rather than Degraded", () => {
  renderWithProviders(
    <LinearInstallationStatus
      installations={installations({
        active: installation({ reconciliation_state: "pending" }),
      })}
      onReauthorize={vi.fn()}
    />,
  );

  expect(screen.getByText("Pending")).toBeInTheDocument();
  expect(screen.queryByText("Degraded")).not.toBeInTheDocument();
});

it("renders only a real reconciliation failure as Degraded with its sanitized reason", () => {
  renderWithProviders(
    <LinearInstallationStatus
      installations={installations({
        active: installation({
          reconciliation_state: "degraded",
          reconciliation_error: "Linear polling failed; reauthorize the installation.",
        }),
      })}
      onReauthorize={vi.fn()}
    />,
  );

  expect(screen.getByText("Degraded")).toBeInTheDocument();
  expect(screen.getByText("Linear polling failed; reauthorize the installation.")).toBeInTheDocument();
});

it("shows an explicit reauthorization action for an active installation", () => {
  const onReauthorize = vi.fn();
  renderWithProviders(
    <LinearInstallationStatus
      installations={installations({
        active: installation({
          state: "reauthorization_required",
          sanitized_reason: "Linear authorization must be renewed",
        }),
      })}
      onReauthorize={onReauthorize}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Reauthorize Linear" }));
  expect(onReauthorize).toHaveBeenCalledOnce();
  expect(screen.getAllByText("Reauthorization required").length).toBeGreaterThan(0);
});

it("offers direct reauthorization after an OAuth callback error", () => {
  const onReauthorize = vi.fn();
  renderWithProviders(
    <LinearInstallationStatus
      installations={installations({
        active: null,
        candidate: installation({
          state: "failed",
          sanitized_reason: "Linear authorization failed safely.",
        }),
      })}
      onReauthorize={onReauthorize}
    />,
    { route: "/integrations?linear=error" },
  );

  fireEvent.click(screen.getByRole("button", { name: "Reauthorize Linear" }));
  expect(onReauthorize).toHaveBeenCalledOnce();
  expect(screen.getByText("Linear authorization failed safely.")).toBeInTheDocument();
});

it("offers project review after a successful authorization callback", () => {
  renderWithProviders(
    <LinearInstallationStatus
      installations={installations()}
      onReauthorize={vi.fn()}
    />,
    { route: "/integrations?linear=connected" },
  );

  expect(screen.getByRole("link", { name: "Review projects" })).toHaveAttribute(
    "href",
    "/setup/scope",
  );
});

it("defers project review until a replacement candidate finishes cutover", () => {
  renderWithProviders(
    <LinearInstallationStatus
      installations={installations({
        candidate: installation({ id: "installation-2", state: "draining" }),
      })}
      onReauthorize={vi.fn()}
    />,
    { route: "/integrations?linear=connected" },
  );

  expect(screen.queryByRole("link", { name: "Review projects" })).not.toBeInTheDocument();
  expect(screen.getByText("Replacement authorization pending")).toBeInTheDocument();
});

it("shows a replacement failure that occurs after a connected callback", () => {
  renderWithProviders(
    <LinearInstallationStatus
      installations={installations({
        candidate: installation({
          id: "installation-2",
          state: "failed",
          sanitized_reason: "The replacement cannot access a bound project.",
        }),
      })}
      onReauthorize={vi.fn()}
    />,
    { route: "/integrations?linear=connected" },
  );

  expect(screen.getByText("Replacement authorization failed")).toBeInTheDocument();
  expect(screen.getByText("The replacement cannot access a bound project.")).toBeInTheDocument();
});

it("does not offer project review after the active installation is gone", () => {
  renderWithProviders(
    <LinearInstallationStatus
      installations={installations({
        active: null,
        revocation: installation({
          state: "disconnected_revocation_failed",
          sanitized_reason: "Linear credential revocation failed",
        }),
      })}
      onReauthorize={vi.fn()}
    />,
    { route: "/integrations?linear=connected" },
  );

  expect(screen.queryByRole("link", { name: "Review projects" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry revocation" })).toBeInTheDocument();
});

it("does not offer project review when the active installation needs reauthorization", () => {
  renderWithProviders(
    <LinearInstallationStatus
      installations={installations({
        active: installation({ state: "reauthorization_required" }),
      })}
      onReauthorize={vi.fn()}
    />,
    { route: "/integrations?linear=connected" },
  );

  expect(screen.queryByRole("link", { name: "Review projects" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reauthorize Linear" })).toBeInTheDocument();
});

it("shows candidate progress and advances cutover explicitly", async () => {
  mockFetch(200, {
    cutover_state: "waiting_for_drain",
    active: installation(),
    candidate: installation({ id: "installation-2", state: "draining" }),
    retirement_error: false,
  });
  renderWithProviders(
    <LinearInstallationStatus
      installations={installations({
        candidate: installation({ id: "installation-2", state: "draining" }),
      })}
      onReauthorize={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Check cutover" }));

  await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
    "/api/v1/linear/installations/cutover",
    expect.objectContaining({ method: "POST" }),
  ));
});

it("distinguishes Conductor preparation from managed-work drain", () => {
  renderWithProviders(
    <LinearInstallationStatus
      installations={installations({
        candidate: installation({ id: "installation-2", state: "preparing" }),
      })}
      onReauthorize={vi.fn()}
    />,
  );

  expect(screen.getByText("Waiting for Conductors to acknowledge the replacement installation.")).toBeInTheDocument();
});

it("offers reauthorization after candidate failure", () => {
  const onReauthorize = vi.fn();
  renderWithProviders(
    <LinearInstallationStatus
      installations={installations({
        candidate: installation({
          id: "installation-2",
          state: "failed",
          sanitized_reason: "The replacement cannot access a bound project.",
        }),
      })}
      onReauthorize={onReauthorize}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Reauthorize Linear" }));
  expect(onReauthorize).toHaveBeenCalledOnce();
  expect(screen.getByText("The replacement cannot access a bound project.")).toBeInTheDocument();
});

it("keeps a durable candidate failure visible for an unknown callback query", () => {
  renderWithProviders(
    <LinearInstallationStatus
      installations={installations({
        candidate: installation({
          id: "installation-2",
          state: "failed",
          sanitized_reason: "The replacement cannot access a bound project.",
        }),
      })}
      onReauthorize={vi.fn()}
    />,
    { route: "/integrations?linear=unexpected" },
  );

  expect(screen.getByText("The replacement cannot access a bound project.")).toBeInTheDocument();
});

it("confirms disconnect and surfaces the backend next action when blocked", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  mockFetch(409, {
    error: {
      code: "linear_disconnect_in_use",
      message: "Unbind active projects before disconnecting Linear",
      next_action: "unbind_projects",
    },
  });
  renderWithProviders(
    <LinearInstallationStatus
      installations={installations()}
      onReauthorize={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Disconnect Linear" }));

  expect(window.confirm).toHaveBeenCalled();
  expect(await screen.findByText("Unbind active projects before disconnecting Linear")).toBeInTheDocument();
  expect(screen.getByText("Unbind projects first")).toBeInTheDocument();
});

it("retries a durable revocation failure", async () => {
  mockFetch(200, { state: "disconnected" });
  renderWithProviders(
    <LinearInstallationStatus
      installations={installations({
        active: null,
        revocation: installation({
          state: "disconnected_revocation_failed",
          sanitized_reason: "Linear credential revocation failed",
        }),
      })}
      onReauthorize={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Retry revocation" }));

  await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
    "/api/v1/linear/installations/installation-1/revoke",
    expect.objectContaining({ method: "POST" }),
  ));
});
