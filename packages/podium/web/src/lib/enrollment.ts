import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useEnrollmentToken, useRuntimes } from "../api/hooks";
import type { EnrollmentToken } from "../api/types";
import { useToast } from "../components/Toast";
import type { EnrollmentPhase } from "../components/InstallCommandCard";
import { useI18n } from "../i18n";

interface EnrollmentState {
  command: string | null;
  token: string | null;
  expiresAt: string | null;
}

const EMPTY_ENROLLMENT: EnrollmentState = {
  command: null,
  token: null,
  expiresAt: null,
};

function expiryLabel(expiresAt: string | null | undefined, t: (key: string, values?: Record<string, string | number>) => string): string {
  if (!expiresAt) return t("Single-use token - regenerate if it expires");
  const when = new Date(expiresAt);
  if (Number.isNaN(when.getTime())) {
    return t("Single-use token - regenerate if it expires");
  }
  return t("Single-use token - expires {time}", { time: when.toLocaleString() });
}

export function useEnrollment({
  pollRuntimes = false,
  online = false,
  initialConductor = null,
  successMessage = "Enrollment token generated",
  errorMessage = "Couldn't generate a token. Try again.",
}: {
  pollRuntimes?: boolean;
  online?: boolean;
  initialConductor?: EnrollmentToken["conductor"] | null;
  successMessage?: string;
  errorMessage?: string;
} = {}) {
  const generate = useEnrollmentToken();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const { t } = useI18n();
  const [state, setState] = useState<EnrollmentState>(EMPTY_ENROLLMENT);
  const [conductor, setConductor] = useState(initialConductor);
  const runtimes = useRuntimes(pollRuntimes && conductor != null);
  const current = runtimes.data?.conductors?.find(
    (row) => row.id === conductor?.id || row.conductor_id === conductor?.id,
  );
  const isOnline = online || Boolean(
    current?.online && current.enrollment_state === "enrolled",
  );

  const clearTransient = useCallback(() => {
    setState(EMPTY_ENROLLMENT);
  }, []);

  useEffect(() => {
    if (isOnline) clearTransient();
  }, [clearTransient, isOnline]);

  async function regenerate(name?: string) {
    clearTransient();
    try {
      const input = conductor
        ? { conductor_id: conductor.id }
        : name ? { name } : {};
      const res = await generate.generate(input);
      setConductor(res.conductor);
      setState({
        command: res.install_command,
        token: res.enrollment_token,
        expiresAt: res.expires_at ?? null,
      });
      await queryClient.invalidateQueries({ queryKey: ["runtimes"] });
      notify(t(successMessage), "success");
    } catch {
      notify(t(errorMessage), "error");
    }
  }

  const phase: EnrollmentPhase = isOnline
    ? "online"
    : state.token
      ? pollRuntimes
        ? "waiting"
        : "idle"
      : "idle";

  return {
    ...state,
    conductor,
    expiresLabel: expiryLabel(state.expiresAt, t),
    phase,
    isOnline,
    clearTransient,
    regenerate,
    regenerating: generate.isPending,
  };
}
