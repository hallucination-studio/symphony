import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/utils";
import LoginPage from "./LoginPage";
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
      login: vi.fn(),
      config: vi.fn().mockResolvedValue({
        turnstile: { enabled: false, site_key: "" },
      }),
    },
  };
});

const mockApi = api as unknown as {
  login: ReturnType<typeof vi.fn>;
  config: ReturnType<typeof vi.fn>;
};

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.config.mockResolvedValue({
      turnstile: { enabled: false, site_key: "" },
    });
    setTurnstileTokenProvider(() => "token-login");
  });

  it("submits credentials and navigates home on success", async () => {
    mockApi.login.mockResolvedValue({
      user: { id: "user_1", email: "a@b.com" },
    });
    renderWithProviders(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "a@b.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });
    const submit = screen.getByRole("button", { name: "Sign in" });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    await waitFor(() =>
      expect(mockApi.login).toHaveBeenCalledWith(
        "a@b.com",
        "password123",
        "token-login",
      ),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/"));
  });

  it("keeps submit disabled until enabled Turnstile returns a token", async () => {
    let callback: ((token: string) => void) | null = null;
    window.turnstile = {
      render: vi.fn((_container, options) => {
        callback = options.callback;
        return "widget-login";
      }),
      remove: vi.fn(),
      reset: vi.fn(),
    };
    mockApi.config.mockResolvedValue({
      turnstile: { enabled: true, site_key: "site-key" },
    });
    mockApi.login.mockResolvedValue({
      user: { id: "user_1", email: "a@b.com" },
    });
    renderWithProviders(<LoginPage />);

    const submit = screen.getByRole("button", { name: "Sign in" });
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
    fireEvent.click(submit);

    await waitFor(() =>
      expect(mockApi.login).toHaveBeenCalledWith(
        "a@b.com",
        "password123",
        "live-token",
      ),
    );
  });

  it("shows a friendly error for invalid credentials", async () => {
    mockApi.login.mockRejectedValue(
      new ApiError(401, "Invalid email or password", "invalid_login"),
    );
    renderWithProviders(<LoginPage />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "a@b.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrongpass1" },
    });
    const submit = screen.getByRole("button", { name: "Sign in" });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    expect(
      await screen.findByText("Invalid email or password"),
    ).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});
