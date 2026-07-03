import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnstileWidget } from "./TurnstileWidget";
import { api } from "../api/client";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: { ...actual.api, config: vi.fn() },
  };
});

const mockApi = api as unknown as { config: ReturnType<typeof vi.fn> };

function renderWidget(props: {
  onToken?: (token: string) => void;
  onReadyChange?: (ready: boolean) => void;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TurnstileWidget
        onToken={props.onToken ?? vi.fn()}
        onReadyChange={props.onReadyChange ?? vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("TurnstileWidget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.head.innerHTML = "";
    delete window.turnstile;
  });

  afterEach(() => {
    document.head.innerHTML = "";
    delete window.turnstile;
  });

  it("renders no challenge and reports ready when Turnstile is disabled", async () => {
    const onToken = vi.fn();
    const onReadyChange = vi.fn();
    mockApi.config.mockResolvedValue({
      turnstile: { enabled: false, site_key: "" },
    });

    const { container } = renderWidget({ onToken, onReadyChange });

    await waitFor(() => expect(onReadyChange).toHaveBeenCalledWith(true));
    expect(onToken).toHaveBeenCalledWith("");
    expect(container.querySelector(".turnstile-widget")).toBeNull();
  });

  it("renders enabled Turnstile, waits for token, and clears readiness on expiry", async () => {
    const onToken = vi.fn();
    const onReadyChange = vi.fn();
    let callbacks: {
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    } | null = null;
    window.turnstile = {
      render: vi.fn((_container, options) => {
        callbacks = options;
        return "widget-1";
      }),
      remove: vi.fn(),
      reset: vi.fn(),
    };
    mockApi.config.mockResolvedValue({
      turnstile: { enabled: true, site_key: "site-key" },
    });

    renderWidget({ onToken, onReadyChange });

    expect(await screen.findByTestId("turnstile-widget")).toBeInTheDocument();
    await waitFor(() => expect(window.turnstile?.render).toHaveBeenCalled());
    expect(onReadyChange).toHaveBeenCalledWith(false);

    act(() => callbacks?.callback("token-123"));

    expect(onToken).toHaveBeenLastCalledWith("token-123");
    expect(onReadyChange).toHaveBeenLastCalledWith(true);

    act(() => callbacks?.["expired-callback"]());

    expect(onToken).toHaveBeenLastCalledWith("");
    expect(onReadyChange).toHaveBeenLastCalledWith(false);
  });
});
