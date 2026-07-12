import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/utils";
import SetupPage from "./SetupPage";
import { api, ApiError } from "../api/client";
import * as navigation from "../lib/navigation";
import type { Bootstrap, OnboardingStepKey } from "../api/types";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      bootstrap: vi.fn(),
      startLinear: vi.fn(),
      linearApplication: vi.fn(),
      linearInstallations: vi.fn(),
      saveLinearApplication: vi.fn(),
      selectDefaultLinearApplication: vi.fn(),
      linearScope: vi.fn(),
      saveScope: vi.fn(),
      saveRepository: vi.fn(),
      enrollmentToken: vi.fn(),
      runtimeStatus: vi.fn(),
      runSmokeCheck: vi.fn(),
      smokeCheckResult: vi.fn(),
    },
  };
});

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

function bootstrap(
  current: OnboardingStepKey,
  completed: OnboardingStepKey[],
): Bootstrap {
  return {
    session: { workspace_id: "default" },
    onboarding: {
      current_step: current,
      completed_steps: completed,
      next_action: "",
    },
    linear: {
      workspace_id: "default",
      state: completed.includes("linear_connect")
        ? "connected"
        : "not_connected",
    },
  };
}

const advancedOnboarding = {
  current_step: "runtime_enrollment",
  completed_steps: ["linear_connect", "scope_selection", "repository_mapping"],
  next_action: "",
} satisfies Bootstrap["onboarding"];

describe("SetupPage repository step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.bootstrap.mockResolvedValue(
      bootstrap("repository_mapping", ["linear_connect", "scope_selection"]),
    );
    mockApi.enrollmentToken.mockResolvedValue({
      enrollment_token: "tok",
      workspace_id: "default",
      install_command:
        "curl -fsSL https://podium.example/install.sh | bash -s -- --enrollment-token tok",
      expires_at: "2026-07-02T12:00:00Z",
    });
    mockApi.runtimeStatus.mockResolvedValue({ online_count: 0 });
  });

  it("submits a local_path mapping and advances to the runtime step", async () => {
    mockApi.saveRepository.mockResolvedValue({
      repository: { mode: "local_path", value: "/srv/repo", validation_state: "valid" },
      onboarding: advancedOnboarding,
    });

    renderWithProviders(<SetupPage />, { route: "/setup/repository", path: "/setup/:step" });

    const input = await screen.findByPlaceholderText(
      "/home/agent/projects/my-repo",
    );
    fireEvent.change(input, { target: { value: "/srv/repo" } });
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));

    await waitFor(() =>
      expect(mockApi.saveRepository).toHaveBeenCalledWith(
        "local_path",
        "/srv/repo",
      ),
    );
    expect(
      await screen.findByText("Generate an install command"),
    ).toBeInTheDocument();
  });

  it("submits a git_url mapping", async () => {
    mockApi.saveRepository.mockResolvedValue({
      repository: {
        mode: "git_url",
        value: "https://example.com/r.git",
        validation_state: "valid",
      },
      onboarding: advancedOnboarding,
    });

    renderWithProviders(<SetupPage />, { route: "/setup/repository", path: "/setup/:step" });

    fireEvent.click(await screen.findByText("Clone from a Git URL"));
    const input = screen.getByPlaceholderText(
      "https://github.com/acme/my-repo.git",
    );
    fireEvent.change(input, { target: { value: "https://example.com/r.git" } });
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));

    await waitFor(() =>
      expect(mockApi.saveRepository).toHaveBeenCalledWith(
        "git_url",
        "https://example.com/r.git",
      ),
    );
  });

  it("shows a client-side error for an invalid git URL without calling the API", async () => {
    renderWithProviders(<SetupPage />, { route: "/setup/repository", path: "/setup/:step" });

    fireEvent.click(await screen.findByText("Clone from a Git URL"));
    const input = screen.getByPlaceholderText(
      "https://github.com/acme/my-repo.git",
    );
    fireEvent.change(input, { target: { value: "not-a-url" } });
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));

    expect(
      await screen.findByText(/Git URL must start with/i),
    ).toBeInTheDocument();
    expect(mockApi.saveRepository).not.toHaveBeenCalled();
  });

  it("surfaces a backend invalid_mode error", async () => {
    mockApi.saveRepository.mockRejectedValue(
      new ApiError(400, "bad mode", "invalid_mode"),
    );

    renderWithProviders(<SetupPage />, { route: "/setup/repository", path: "/setup/:step" });

    const input = await screen.findByPlaceholderText(
      "/home/agent/projects/my-repo",
    );
    fireEvent.change(input, { target: { value: "/srv/repo" } });
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));

    expect(
      await screen.findByText(/repository mode isn't supported/i),
    ).toBeInTheDocument();
  });
});

describe("SetupPage runtime step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.bootstrap.mockResolvedValue(
      bootstrap("runtime_enrollment", [
        "linear_connect",
        "scope_selection",
        "repository_mapping",
      ]),
    );
    mockApi.runtimeStatus.mockResolvedValue({ online_count: 0 });
    mockApi.enrollmentToken.mockResolvedValue({
      enrollment_token: "tok",
      workspace_id: "default",
      install_command:
        "curl -fsSL https://podium.example/install.sh | bash -s -- --enrollment-token tok",
      expires_at: "2026-07-02T12:00:00Z",
    });
  });

  it("renders the backend-provided install command, not a hardcoded host", async () => {
    renderWithProviders(<SetupPage />, {
      route: "/setup/runtime",
      path: "/setup/:step",
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /generate install command/i }),
    );

    const command = await screen.findByText(
      "curl -fsSL https://podium.example/install.sh | bash -s -- --enrollment-token tok",
    );
    expect(command).toBeInTheDocument();
  });

  it("updates the install command when regenerated", async () => {
    mockApi.enrollmentToken
      .mockResolvedValueOnce({
        enrollment_token: "tok-1",
        workspace_id: "default",
        install_command: "install --token tok-1",
        expires_at: "2026-07-02T12:00:00Z",
      })
      .mockResolvedValueOnce({
        enrollment_token: "tok-2",
        workspace_id: "default",
        install_command: "install --token tok-2",
        expires_at: "2026-07-02T13:00:00Z",
      });

    renderWithProviders(<SetupPage />, {
      route: "/setup/runtime",
      path: "/setup/:step",
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /generate install command/i }),
    );
    expect(await screen.findByText("install --token tok-1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /regenerate command/i }));
    expect(await screen.findByText("install --token tok-2")).toBeInTheDocument();
  });
});

describe("SetupPage linear step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.linearApplication.mockResolvedValue({
      application: {
        id: "app-default",
        source: "default",
        version: 1,
        client_id: "default-client",
        callback_url: "https://podium.example/api/v1/linear/oauth/callback",
      },
    });
    mockApi.linearInstallations.mockResolvedValue({ active: null, candidate: null, revocation: null });
  });

  it("shows connected state when Linear is connected", async () => {
    mockApi.bootstrap.mockResolvedValue(
      bootstrap("scope_selection", ["linear_connect"]),
    );
    renderWithProviders(<SetupPage />, { route: "/setup/linear", path: "/setup/:step" });
    expect(await screen.findByRole("button", { name: "Reauthorize Linear" })).toBeInTheDocument();
  });

  it("offers to connect when not connected", async () => {
    mockApi.bootstrap.mockResolvedValue(bootstrap("linear_connect", []));
    renderWithProviders(<SetupPage />, { route: "/setup/linear", path: "/setup/:step" });
    expect(await screen.findByText("Authorize Linear")).toBeInTheDocument();
  });

  it("starts Linear OAuth and redirects through the shared connect path", async () => {
    mockApi.bootstrap.mockResolvedValue(bootstrap("linear_connect", []));
    mockApi.startLinear.mockResolvedValue({
      authorization_url: "https://linear.example/oauth",
      workspace_id: "default",
    });
    const assign = vi
      .spyOn(navigation, "assignLocation")
      .mockImplementation(() => undefined);

    renderWithProviders(<SetupPage />, { route: "/setup/linear", path: "/setup/:step" });

    fireEvent.click(await screen.findByRole("button", { name: "Authorize Linear" }));

    await waitFor(() => expect(mockApi.startLinear).toHaveBeenCalled());
    expect(assign).toHaveBeenCalledWith("https://linear.example/oauth");
    assign.mockRestore();
  });
});
