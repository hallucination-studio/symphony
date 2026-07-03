import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "./client";
import type { RepositoryMode } from "./types";

export function useBootstrap() {
  return useQuery({
    queryKey: ["bootstrap"],
    queryFn: () => api.bootstrap(),
  });
}

export function useLinearScope(enabled = true) {
  return useQuery({
    queryKey: ["linear", "scope"],
    queryFn: () => api.linearScope(),
    enabled,
    retry: false,
  });
}

export function useRuntimes() {
  return useQuery({
    queryKey: ["runtimes"],
    queryFn: () => api.runtimes(),
  });
}

export function useRecentRuns(limit = 10) {
  return useQuery({
    queryKey: ["runs", "recent", limit],
    queryFn: () => api.recentRuns(limit),
  });
}

export function useSmokeCheckResult() {
  return useQuery({
    queryKey: ["smoke-check"],
    queryFn: () => api.smokeCheckResult(),
    retry: false,
  });
}

/**
 * Runtime enrollment status. `polling` switches on a short interval so the
 * Install step can watch for the runtime coming online without a refresh.
 */
export function useRuntimeStatus(polling = false) {
  return useQuery({
    queryKey: ["runtime-status"],
    queryFn: () => api.runtimeStatus(),
    refetchInterval: polling ? 3000 : false,
  });
}

// ===== Mutations =====

// Onboarding progress touches multiple cached queries; invalidate the shared
// ones after any advancing mutation so every view reflects the new step.
function useInvalidateOnboarding() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["bootstrap"] });
  };
}

export function useStartLinear() {
  return useMutation({
    mutationFn: () => api.startLinear(),
  });
}

export function useSaveScope() {
  const invalidate = useInvalidateOnboarding();
  return useMutation({
    mutationFn: ({ teams, projects }: { teams: string[]; projects: string[] }) =>
      api.saveScope(teams, projects),
    onSuccess: invalidate,
  });
}

export function useSaveRepository() {
  const invalidate = useInvalidateOnboarding();
  return useMutation({
    mutationFn: ({ mode, value }: { mode: RepositoryMode; value: string }) =>
      api.saveRepository(mode, value),
    onSuccess: invalidate,
  });
}

export function useEnrollmentToken() {
  return useMutation({
    mutationFn: () => api.enrollmentToken(),
  });
}

export function useRunSmokeCheck() {
  const invalidate = useInvalidateOnboarding();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.runSmokeCheck(),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["smoke-check"] });
    },
  });
}
