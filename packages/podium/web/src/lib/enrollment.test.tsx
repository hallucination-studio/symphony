import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/Toast";
import { I18nProvider } from "../i18n";
import { useEnrollment } from "./enrollment";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  useRuntimes: vi.fn(),
}));

vi.mock("../api/hooks", () => ({
  useEnrollmentToken: () => ({ generate: mocks.generate, isPending: false }),
  useRuntimes: (...args: unknown[]) => mocks.useRuntimes(...args),
}));

function wrapper({ children }: PropsWithChildren) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ToastProvider>{children}</ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

function enrollmentResponse(token: string) {
  return {
    enrollment_token: token,
    install_command: `install ${token}`,
    expires_at: "2026-07-14T12:00:00Z",
    conductor: {
      id: "conductor-1",
      name: "Bach",
      public_id: "k7m3p2",
      enrollment_state: "pending" as const,
      hostname: "",
      version: "",
      service_identity: "symphony-conductor-k7m3p2",
      data_root: "",
      online: false,
      last_report_at: null,
      binding: null,
    },
  };
}

describe("useEnrollment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useRuntimes.mockReturnValue({ data: { conductors: [], runtimes: [] } });
  });

  it("clears the old command before regenerating for the same identity", async () => {
    let resolveReplacement: ((value: ReturnType<typeof enrollmentResponse>) => void) | undefined;
    mocks.generate
      .mockResolvedValueOnce(enrollmentResponse("token-one"))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveReplacement = resolve;
      }));
    const { result } = renderHook(() => useEnrollment(), { wrapper });

    await act(() => result.current.regenerate("Bach"));
    expect(result.current.command).toBe("install token-one");

    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.regenerate();
    });

    expect(result.current.command).toBeNull();
    expect(result.current.token).toBeNull();
    expect(mocks.generate).toHaveBeenNthCalledWith(1, { name: "Bach" });
    expect(mocks.generate).toHaveBeenNthCalledWith(2, { conductor_id: "conductor-1" });

    resolveReplacement?.(enrollmentResponse("token-two"));
    await act(() => pending!);
    expect(result.current.command).toBe("install token-two");
  });

  it("clears secrets only when the exact reserved Conductor becomes online", async () => {
    const conductors = [
      { id: "other", conductor_id: "other", enrollment_state: "enrolled", online: true },
      { id: "conductor-1", conductor_id: "conductor-1", enrollment_state: "pending", online: false },
    ];
    mocks.useRuntimes.mockImplementation(() => ({ data: { conductors, runtimes: [] } }));
    mocks.generate.mockResolvedValue(enrollmentResponse("target-token"));
    const { result, rerender } = renderHook(
      () => useEnrollment({ pollRuntimes: true }),
      { wrapper },
    );

    await act(() => result.current.regenerate("Bach"));
    rerender();
    expect(result.current.isOnline).toBe(false);
    expect(result.current.command).toBe("install target-token");

    conductors[1] = {
      ...conductors[1],
      enrollment_state: "enrolled",
      online: true,
    };
    rerender();

    await waitFor(() => expect(result.current.isOnline).toBe(true));
    expect(result.current.command).toBeNull();
    expect(result.current.token).toBeNull();
  });
});
