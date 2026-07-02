import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/utils";
import { InstallCommandCard } from "./InstallCommandCard";

describe("InstallCommandCard", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("copies the command and confirms with a toast", async () => {
    renderWithProviders(
      <InstallCommandCard command="curl install | sh" phase="idle" />,
    );

    fireEvent.click(screen.getByRole("button", { name: /copy/i }));

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "curl install | sh",
      ),
    );
    expect(
      await screen.findByText("Install command copied"),
    ).toBeInTheDocument();
  });

  it("shows a waiting state while the runtime hasn't checked in", () => {
    renderWithProviders(
      <InstallCommandCard command="cmd" token="tok" phase="waiting" />,
    );
    expect(
      screen.getByText(/Waiting for the runtime to check in/i),
    ).toBeInTheDocument();
  });

  it("flips to connected once the runtime is online", () => {
    renderWithProviders(
      <InstallCommandCard command="cmd" token="tok" phase="online" />,
    );
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText(/Runtime connected/i)).toBeInTheDocument();
  });
});
