import { useQuery } from "@tanstack/react-query";
import { api, DEFAULT_WORKSPACE_ID } from "./client";

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
