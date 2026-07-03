import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
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
    api: { login: vi.fn() },
  };
});

const mockApi = api as unknown as { login: ReturnType<typeof vi.fn> };

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(mockApi.login).toHaveBeenCalledWith(
        "a@b.com",
        "password123",
        "token-login",
      ),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/"));
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
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(
      await screen.findByText("Invalid email or password"),
    ).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});
