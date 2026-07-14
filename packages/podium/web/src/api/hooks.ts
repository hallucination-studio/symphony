import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { api } from "./client";
import type {
  AuthenticationChallenge,
  LinearProject,
  PerformerControlEnvelope,
  PerformerDeviceLoginRequest,
  RepositoryMode,
} from "./types";

export function useBootstrap() {
  return useQuery({
    queryKey: ["bootstrap"],
    queryFn: () => api.bootstrap(),
  });
}

export function useConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: () => api.config(),
    staleTime: Infinity,
    gcTime: 60 * 60 * 1000,
  });
}

export function useLinearProjects(enabled = true) {
  return useQuery({
    queryKey: ["linear", "projects"],
    queryFn: () => api.linearProjects(),
    enabled,
    retry: false,
  });
}

export function useLinearApplication() {
  return useQuery({
    queryKey: ["linear", "application"],
    queryFn: () => api.linearApplication(),
    retry: false,
  });
}

export function useLinearInstallations() {
  return useQuery({
    queryKey: ["linear", "installations"],
    queryFn: () => api.linearInstallations(),
    retry: false,
  });
}

export function useRuntimes() {
  return useQuery({
    queryKey: ["runtimes"],
    queryFn: () => api.runtimes(),
    // Conductors report metrics/queue/logs on a short cycle; keep the view live.
    refetchInterval: 5000,
  });
}

/**
 * Tail of a Performer's log for the detail drawer. `live` polls on a short
 * interval so operators can watch a run without refreshing.
 */
export function useInstanceLogs(
  conductorId: string | null,
  instanceId: string | null,
  live = true,
) {
  return useQuery({
    queryKey: ["instance-logs", conductorId, instanceId],
    queryFn: () => api.instanceLogs(conductorId!, instanceId!, { tail: 200, order: "desc" }),
    enabled: Boolean(conductorId && instanceId),
    refetchInterval: live ? 3000 : false,
  });
}

export function useManagedRuns() {
  return useQuery({
    queryKey: ["managed-runs"],
    queryFn: () => api.managedRuns(),
    refetchInterval: 5000,
  });
}

export function usePerformerStatus(conductorId: string | null) {
  return useQuery({
    queryKey: ["performer", conductorId, "status"],
    queryFn: () => api.performerStatus(conductorId!),
    enabled: Boolean(conductorId),
    retry: false,
  });
}

/**
 * Live controls intentionally avoid useMutation. TanStack retains mutation
 * variables and results for inspection; API keys, device challenges, and
 * config source are transient drawer state and must never enter that cache.
 */
export function usePerformerControl(conductorId: string) {
  const qc = useQueryClient();
  const [challenge, setChallenge] = useState<AuthenticationChallenge | null>(null);
  const [configurationSource, setConfigurationSource] = useState<string | null>(null);

  const clearTransient = useCallback(() => {
    setChallenge(null);
    setConfigurationSource(null);
  }, []);

  useEffect(() => clearTransient, [clearTransient]);

  const refreshStatus = useCallback(() => qc.invalidateQueries({
    queryKey: ["performer", conductorId, "status"],
  }), [conductorId, qc]);

  const login = useCallback(async (input: PerformerDeviceLoginRequest) => {
    setChallenge(null);
    const envelope = await api.performerLogin(conductorId, input);
    const result = envelope.control_result;
    const pending = envelope.events.find((event) => event.event_kind === "login.pending");
    if (pending?.verification_url && pending.user_code) {
      setChallenge({
        kind: "device_code",
        message: pending.message,
        verification_url: pending.verification_url,
        user_code: pending.user_code,
        expires_at: pending.expires_at,
      });
    }
    await refreshStatus();
    return { envelope, result };
  }, [conductorId, refreshStatus]);

  const loginWithApiKey = useCallback((takeApiKey: () => string) => {
    setChallenge(null);
    const dispatched = api.performerApiKeyLogin(conductorId, takeApiKey);
    return finishPerformerControl(dispatched, refreshStatus);
  }, [conductorId, refreshStatus]);

  const deleteSession = useCallback(async (action: "cancel_login" | "logout") => {
    const envelope = await api.deletePerformerSession(conductorId, action);
    const result = envelope.control_result;
    setChallenge(null);
    await refreshStatus();
    return { envelope, result };
  }, [conductorId, refreshStatus]);

  const readConfiguration = useCallback(async () => {
    const envelope = await api.performerConfiguration(conductorId);
    const result = envelope.control_result;
    setConfigurationSource(
      result.status === "succeeded" ? result.configuration?.source_text ?? null : null,
    );
    return { envelope, result };
  }, [conductorId]);

  const writeConfiguration = useCallback(async (value: string) => {
    const envelope = await api.updatePerformerConfiguration(conductorId, {
      setting: "api_base_url",
      value,
    });
    const result = envelope.control_result;
    setConfigurationSource(null);
    await refreshStatus();
    return { envelope, result };
  }, [conductorId, refreshStatus]);

  const check = useCallback(async () => {
    const envelope = await api.checkPerformer(conductorId);
    const result = envelope.control_result;
    await refreshStatus();
    return { envelope, result };
  }, [conductorId, refreshStatus]);

  return {
    challenge,
    configurationSource,
    setAuthenticationChallenge: setChallenge,
    clearTransient,
    login,
    loginWithApiKey,
    deleteSession,
    readConfiguration,
    writeConfiguration,
    check,
  };
}

async function finishPerformerControl(
  dispatched: Promise<PerformerControlEnvelope>,
  refreshStatus: () => Promise<unknown>,
) {
  const envelope = await dispatched;
  const result = envelope.control_result;
  await refreshStatus();
  return { envelope, result };
}

export function useSmokeCheckResult() {
  return useQuery({
    queryKey: ["smoke-check"],
    queryFn: () => api.smokeCheckResult(),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 1000 : false,
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

export function useSelectLinearProjects() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectIds: string[]) => api.selectLinearProjects(projectIds),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["bootstrap"] }),
        qc.invalidateQueries({ queryKey: ["linear", "projects"] }),
        qc.invalidateQueries({ queryKey: ["runtimes"] }),
        qc.invalidateQueries({ queryKey: ["runtime-status"] }),
        qc.invalidateQueries({ queryKey: ["smoke-check"] }),
      ]);
    },
  });
}

export function useLinearProjectSelection(enabled = true) {
  const query = useLinearProjects(enabled);
  const mutation = useSelectLinearProjects();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const projects = query.data?.projects ?? [];

  useEffect(() => {
    if (!query.data) return;
    setSelected(new Set(
      query.data.projects
        .filter((project) => project.selected || project.bound)
        .map((project) => project.id),
    ));
  }, [query.data]);

  function toggle(project: LinearProject) {
    if (project.bound) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(project.id)) next.delete(project.id);
      else next.add(project.id);
      return next;
    });
  }

  return {
    query,
    projects,
    selected,
    toggle,
    selectAll: () => setSelected(new Set(projects.map((project) => project.id))),
    save: () => mutation.mutateAsync([...selected].sort()),
    saving: mutation.isPending,
    canSave: selected.size > 0,
  };
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
    onSuccess: (result) => {
      qc.setQueryData(["smoke-check"], result);
      invalidate();
    },
  });
}
