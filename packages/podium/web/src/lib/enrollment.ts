import { useState } from "react";
import { useEnrollmentToken, useRuntimeStatus } from "../api/hooks";
import { useToast } from "../components/Toast";
import type { EnrollmentPhase } from "../components/InstallCommandCard";
import { useI18n } from "../i18n";

interface EnrollmentState {
  command: string | null;
  token: string | null;
  expiresAt: string | null;
}

function expiryLabel(expiresAt: string | null | undefined, t: (key: string, values?: Record<string, string | number>) => string): string {
  if (!expiresAt) return t("Single-use token - regenerate if it expires");
  const when = new Date(expiresAt);
  if (Number.isNaN(when.getTime())) {
    return t("Single-use token - regenerate if it expires");
  }
  return t("Single-use token - expires {time}", { time: when.toLocaleString() });
}

export function useEnrollment({
  pollRuntimeStatus = false,
  online = false,
  successMessage = "Enrollment token generated",
  errorMessage = "Couldn't generate a token. Try again.",
}: {
  pollRuntimeStatus?: boolean;
  online?: boolean;
  successMessage?: string;
  errorMessage?: string;
} = {}) {
  const generate = useEnrollmentToken();
  const { notify } = useToast();
  const { t } = useI18n();
  const [state, setState] = useState<EnrollmentState>({
    command: null,
    token: null,
    expiresAt: null,
  });

  const status = useRuntimeStatus(pollRuntimeStatus && state.token != null);
  const isOnline = online || (status.data?.online_count ?? 0) > 0;

  async function regenerate() {
    try {
      const res = await generate.mutateAsync();
      setState({
        command: res.install_command,
        token: res.enrollment_token,
        expiresAt: res.expires_at ?? null,
      });
      notify(t(successMessage), "success");
    } catch {
      notify(t(errorMessage), "error");
    }
  }

  const phase: EnrollmentPhase = isOnline
    ? "online"
    : state.token
      ? pollRuntimeStatus
        ? "waiting"
        : "idle"
      : "idle";

  return {
    ...state,
    expiresLabel: expiryLabel(state.expiresAt, t),
    phase,
    isOnline,
    regenerate,
    regenerating: generate.isPending,
  };
}
