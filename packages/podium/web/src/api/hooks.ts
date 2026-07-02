import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api, DEFAULT_WORKSPACE_ID } from "./client";
import type { RepositoryMode } from "./types";

export function useBootstrap(workspaceId: string = DEFAULT_WORKSPACE_ID) {
  return useQuery({
    queryKey: ["bootstrap", workspaceId],
    queryFn: () => api.bootstrap(workspaceId),
  });
}

export function useOnboardingStatus(workspaceId: string = DEFAULT_WORKSPACE_ID) {
  return useQuery({
    queryKey: ["onboarding", workspaceId],
    queryFn: () => api.onboardingStatus(workspaceId),
  });
}

export function useLinearScope(
  workspaceId: string = DEFAULT_WORKSPACE_ID,
  enabled = true,
) {
  return useQuery({
    queryKey: ["linear", "scope", workspaceId],
    queryFn: () => api.linearScope(workspaceId),
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

export function useRuntime(id: string | null) {
  return useQuery({
    queryKey: ["runtime", id],
    queryFn: () => api.runtime(id as string),
    enabled: Boolean(id),
  });
}

export function useRecentRuns(limit = 10) {
  return useQuery({
    queryKey: ["runs", "recent", limit],
    queryFn: () => api.recentRuns(limit),
  });
}

export function useRun(id: string | null) {
  return useQuery({
    queryKey: ["run", id],
    queryFn: () => api.run(id as string),
    enabled: Boolean(id),
  });
}

export function useSmokeCheckResult(
  workspaceId: string = DEFAULT_WORKSPACE_ID,
) {
  return useQuery({
    queryKey: ["smoke-check", workspaceId],
    queryFn: () => api.smokeCheckResult(workspaceId),
    retry: false,
  });
}

/**
 * Runtime enrollment status. `polling` switches on a short interval so the
 * Install step can watch for the runtime coming online without a refresh.
 */
export function useRuntimeStatus(
  workspaceId: string = DEFAULT_WORKSPACE_ID,
  polling = false,
) {
  return useQuery({
    queryKey: ["runtime-status", workspaceId],
    queryFn: () => api.runtimeStatus(workspaceId),
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
    qc.invalidateQueries({ queryKey: ["onboarding"] });
  };
}

export function useStartLinear(workspaceId: string = DEFAULT_WORKSPACE_ID) {
  return useMutation({
    mutationFn: () => api.startLinear(workspaceId),
  });
}

export function useSaveScope(workspaceId: string = DEFAULT_WORKSPACE_ID) {
  const invalidate = useInvalidateOnboarding();
  return useMutation({
    mutationFn: ({ teams, projects }: { teams: string[]; projects: string[] }) =>
      api.saveScope(workspaceId, teams, projects),
    onSuccess: invalidate,
  });
}

export function useSaveRepository(workspaceId: string = DEFAULT_WORKSPACE_ID) {
  const invalidate = useInvalidateOnboarding();
  return useMutation({
    mutationFn: ({ mode, value }: { mode: RepositoryMode; value: string }) =>
      api.saveRepository(workspaceId, mode, value),
    onSuccess: invalidate,
  });
}

export function useEnrollmentToken(workspaceId: string = DEFAULT_WORKSPACE_ID) {
  return useMutation({
    mutationFn: () => api.enrollmentToken(workspaceId),
  });
}

export function useRunSmokeCheck(workspaceId: string = DEFAULT_WORKSPACE_ID) {
  const invalidate = useInvalidateOnboarding();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.runSmokeCheck(workspaceId),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["smoke-check"] });
    },
  });
}
