import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/utils";
import type { PerformerStatus } from "../api/types";
import { RuntimesPerformerDrawer } from "./RuntimesPerformerDrawer";

const mocks = vi.hoisted(() => ({
  usePerformerStatus: vi.fn(),
  usePerformerControl: vi.fn(),
  useInstanceLogs: vi.fn(),
}));

vi.mock("../api/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/hooks")>();
  return { ...actual, ...mocks };
});

const control = {
  challenge: null,
  configurationSource: null,
  clearTransient: vi.fn(),
  login: vi.fn(),
  loginWithApiKey: vi.fn(),
  deleteSession: vi.fn(),
  readConfiguration: vi.fn(),
  writeConfiguration: vi.fn(),
  check: vi.fn(),
};

describe("RuntimesPerformerDrawer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.usePerformerStatus.mockReturnValue({
      data: status(),
      isLoading: false,
      error: null,
    });
    mocks.usePerformerControl.mockReturnValue(control);
    mocks.useInstanceLogs.mockReturnValue({
      data: { logs: { lines: ["event=performer_backend_invoked"] } },
      isLoading: false,
      error: null,
    });
    control.login.mockResolvedValue({ result: successResult("performer.login") });
    control.loginWithApiKey.mockImplementation((takeApiKey: () => string) => {
      takeApiKey();
      return Promise.resolve({ result: successResult("performer.login") });
    });
    control.deleteSession.mockResolvedValue({ result: successResult("performer.session.delete") });
    control.readConfiguration.mockResolvedValue({
      result: {
        ...successResult("performer.config.read"),
        configuration: {
          settings: { api_base_url: "https://api.example.test/v1" },
          source_format: "text",
          source_text: 'model = "gpt-5.4"',
        },
      },
    });
    control.writeConfiguration.mockResolvedValue({ result: successResult("performer.config.write") });
    control.check.mockResolvedValue({ result: successResult("performer.check") });
  });

  it("renders controls only from declared Performer capabilities", () => {
    renderWithProviders(
      <RuntimesPerformerDrawer
        conductorId="conductor-1"
        performerName="Primary Performer"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Codex · Primary Performer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start device login" })).toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Read configuration" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Check" })).toBeInTheDocument();
  });

  it("clears the API key before awaiting the transient login call", async () => {
    let resolveLogin: ((value: unknown) => void) | undefined;
    control.loginWithApiKey.mockImplementation((takeApiKey: () => string) => {
      takeApiKey();
      return new Promise((resolve) => { resolveLogin = resolve; });
    });
    renderWithProviders(
      <RuntimesPerformerDrawer
        conductorId="conductor-1"
        performerName="Primary Performer"
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("API key") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-transient-browser-secret" } });

    fireEvent.click(screen.getByRole("button", { name: "Sign in with API key" }));

    expect(control.loginWithApiKey).toHaveBeenCalledOnce();
    expect(control.login).not.toHaveBeenCalledWith(expect.objectContaining({
      method: "api_key",
    }));
    expect(input.value).toBe("");
    resolveLogin?.({ result: successResult("performer.login") });
    await waitFor(() => expect(
      screen.getByText("API key login accepted. Run Check before starting work."),
    ).toBeInTheDocument());
  });

  it("shows a device challenge and clears transient state on close", () => {
    const onClose = vi.fn();
    mocks.usePerformerControl.mockReturnValue({
      ...control,
      challenge: {
        kind: "device_code",
        message: "Open the verification page",
        verification_url: "https://example.test/device",
        user_code: "ABCD-EFGH",
        expires_at: null,
      },
      configurationSource: 'model = "gpt-5.4"',
    });
    renderWithProviders(
      <RuntimesPerformerDrawer
        conductorId="conductor-1"
        performerName="Primary Performer"
        onClose={onClose}
      />,
    );

    expect(screen.getByText("ABCD-EFGH")).toBeInTheDocument();
    expect(screen.getByText('model = "gpt-5.4"')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(control.clearTransient).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders current and last Check readiness evidence", () => {
    mocks.usePerformerStatus.mockReturnValue({
      data: {
        ...status(),
        readiness: {
          ...status().readiness,
          status: "failed",
          last_check_status: "failed",
          error: {
            error_code: "performer_check_failed",
            sanitized_reason: "The structured Check failed.",
            action_required: true,
            retryable: false,
            attempt_number: 1,
            next_action: "Repair the backend and run Check again.",
          },
        },
      },
      isLoading: false,
      error: null,
    });
    renderWithProviders(
      <RuntimesPerformerDrawer
        conductorId="conductor-1"
        performerName="Primary Performer"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("The structured Check failed.")).toBeInTheDocument();
    expect(screen.getByText("Last Check: failed")).toBeInTheDocument();
  });

  it("hides a stale device challenge when capabilities no longer declare device login", () => {
    mocks.usePerformerStatus.mockReturnValue({
      data: status({ login_methods: ["api_key"] }),
      isLoading: false,
      error: null,
    });
    mocks.usePerformerControl.mockReturnValue({
      ...control,
      challenge: {
        kind: "device_code",
        message: "Open the verification page",
        verification_url: "https://example.test/device",
        user_code: "ABCD-EFGH",
        expires_at: null,
      },
    });
    renderWithProviders(
      <RuntimesPerformerDrawer
        conductorId="conductor-1"
        performerName="Primary Performer"
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText("ABCD-EFGH")).not.toBeInTheDocument();
  });

  it("does not invent unsupported login, configuration, or Check controls", () => {
    mocks.usePerformerStatus.mockReturnValue({
      data: status({
        login_methods: [],
        supports_session_delete: false,
        editable_settings: [],
        config_source_visible: false,
        check_supported: false,
      }),
      isLoading: false,
      error: null,
    });
    renderWithProviders(
      <RuntimesPerformerDrawer
        conductorId="conductor-1"
        performerName="Limited Performer"
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Start device login" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Read configuration" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run Check" })).not.toBeInTheDocument();
  });

  it("keeps runtime constraints, Conductor details, and logs reachable", () => {
    renderWithProviders(
      <RuntimesPerformerDrawer
        conductorId="conductor-1"
        performerName="Primary Performer"
        conductor={conductor()}
        performer={performer()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("SYM")).toBeInTheDocument();
    expect(screen.getByText("Studio")).toBeInTheDocument();
    expect(screen.getByText("event=performer_backend_invoked")).toBeInTheDocument();
  });

  it("shows the sanitized status failure instead of hiding it", () => {
    mocks.usePerformerStatus.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Performer backend setup failed."),
    });
    renderWithProviders(
      <RuntimesPerformerDrawer
        conductorId="conductor-1"
        performerName="Primary Performer"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Performer backend setup failed.",
    );
  });
});

function conductor() {
  return {
    conductor_id: "conductor-1",
    hostname: "studio-mac",
    label: "Studio",
    version: "1.0.0",
    online: true,
    last_report_at: "2026-07-13T10:00:00Z",
    bindings: [],
  };
}

function performer() {
  return {
    id: "binding-1",
    instance_id: "instance-1",
    name: "Primary Performer",
    linear_project: "project-1",
    project_slug: "SYM",
    agent_app_user_id: "app-1",
    managed_run_profile: "default",
    process_status: "ready",
    constraint_labels: ["symphony:managed"],
  };
}

function status(
  capabilityOverrides: Partial<PerformerStatus["capabilities"]> = {},
): PerformerStatus {
  return {
    capabilities: {
      protocol_version: 1,
      capability_version: 1,
      performer_kind: "codex",
      display_name: "Codex",
      turn_kinds: ["plan", "execute", "gate"],
      login_methods: ["device_code", "api_key"],
      supports_session_delete: true,
      editable_settings: ["api_base_url"],
      config_source_visible: true,
      check_supported: true,
      ...capabilityOverrides,
    },
    readiness: {
      performer_kind: "codex",
      binding_generation: 1,
      capability_version: 1,
      execution_policy_sha256: "a".repeat(64),
      status: "unchecked",
      last_check_status: "none",
      error: null,
    },
    account: { status: "logged_out", display_label: null },
    login: { status: "idle", method: null },
  };
}

function successResult(operation: string) {
  return {
    protocol_version: 1,
    request_id: "ui-control",
    operation,
    status: "succeeded",
    capabilities: null,
    readiness: null,
    account: null,
    login: null,
    configuration: null,
    check: null,
    error: null,
  };
}
