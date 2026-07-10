import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { api } from "../api/client";
import { renderWithProviders } from "../test/utils";
import AccountPage from "./AccountPage";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      me: vi.fn(),
      logout: vi.fn(),
    },
  };
});

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe("AccountPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.me.mockResolvedValue({ user: { id: "user_1", email: "user@example.com" } });
  });

  it("renders only account identity and no Linear application controls", async () => {
    renderWithProviders(<AccountPage />);

    expect(await screen.findByText("user@example.com")).toBeInTheDocument();
    expect(screen.getByText("user_1")).toBeInTheDocument();
    expect(screen.queryByText("Linear application")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Client ID")).not.toBeInTheDocument();
  });

  it("logs out via api.logout", async () => {
    mockApi.logout.mockResolvedValue({ ok: true });
    renderWithProviders(<AccountPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));

    await waitFor(() => expect(mockApi.logout).toHaveBeenCalledOnce());
  });
});
