import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/utils";
import RegisterPage from "./RegisterPage";
import { api, ApiError } from "../api/client";
import { setTurnstileTokenProvider } from "../lib/turnstile";

const navigate = vi.fn();

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigate };
});

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      register: vi.fn(),
      config: vi.fn().mockResolvedValue({
        turnstile: { enabled: false, site_key: "" },
      }),
    },
  };
});

const mockApi = api as unknown as {
  register: ReturnType<typeof vi.fn>;
  config: ReturnType<typeof vi.fn>;
};

describe("RegisterPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.config.mockResolvedValue({
      turnstile: { enabled: false, site_key: "" },
    });
    setTurnstileTokenProvider(() => "token-register");
  });

  it("blocks submission when passwords don't match", async () => {
    renderWithProviders(<RegisterPage />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "a@b.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "different1" },
    });
    const submit = screen.getByRole("button", { name: "Create account" });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    expect(await screen.findByText("Passwords don't match.")).toBeInTheDocument();
    expect(mockApi.register).not.toHaveBeenCalled();
  });

  it("registers and navigates home on success, sending a turnstile token", async () => {
    mockApi.register.mockResolvedValue({
      user: { id: "user_1", email: "a@b.com" },
    });
    renderWithProviders(<RegisterPage />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "a@b.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "password123" },
    });
    const submit = screen.getByRole("button", { name: "Create account" });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    await waitFor(() =>
      expect(mockApi.register).toHaveBeenCalledWith(
        "a@b.com",
        "password123",
        "token-register",
      ),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/"));
  });

  it("keeps submit disabled until enabled Turnstile returns a token", async () => {
    let callback: ((token: string) => void) | null = null;
    window.turnstile = {
      render: vi.fn((_container, options) => {
        callback = options.callback;
        return "widget-register";
      }),
      remove: vi.fn(),
      reset: vi.fn(),
    };
    mockApi.config.mockResolvedValue({
      turnstile: { enabled: true, site_key: "site-key" },
    });
    mockApi.register.mockResolvedValue({
      user: { id: "user_1", email: "a@b.com" },
    });
    renderWithProviders(<RegisterPage />);

    const submit = screen.getByRole("button", { name: "Create account" });
    expect(submit).toBeDisabled();
    await waitFor(() => expect(window.turnstile?.render).toHaveBeenCalled());
    expect(submit).toBeDisabled();

    act(() => {
      callback?.("live-token");
    });

    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "a@b.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "password123" },
    });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(mockApi.register).toHaveBeenCalledWith(
        "a@b.com",
        "password123",
        "live-token",
      ),
    );
  });

  it("shows a friendly error when the email is already taken", async () => {
    mockApi.register.mockRejectedValue(
      new ApiError(400, "Email already registered", "email_already_registered"),
    );
    renderWithProviders(<RegisterPage />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "a@b.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "password123" },
    });
    const submit = screen.getByRole("button", { name: "Create account" });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    expect(
      await screen.findByText(
        "That email is already registered — sign in instead.",
      ),
    ).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});
