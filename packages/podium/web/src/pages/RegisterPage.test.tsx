import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "../test/utils";
import RegisterPage from "./RegisterPage";
import { api, ApiError } from "../api/client";

const navigate = vi.fn();

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigate };
});

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: { register: vi.fn() },
  };
});

const mockApi = api as unknown as { register: ReturnType<typeof vi.fn> };

describe("RegisterPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Passwords don't match.")).toBeInTheDocument();
    expect(mockApi.register).not.toHaveBeenCalled();
  });

  it("shows a friendly error when the email is already taken", async () => {
    mockApi.register.mockRejectedValue(
      new ApiError(400, "Email already registered", "email_taken"),
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
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      await screen.findByText(
        "That email is already registered — sign in instead.",
      ),
    ).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});
