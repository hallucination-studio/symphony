import { useStartLinear } from "../api/hooks";
import { useToast } from "../components/Toast";
import { useI18n } from "../i18n";
import { assignLocation } from "./navigation";
import type { LinearStatus } from "../api/types";
import type { GlobalStatus } from "./format";
import type { ActionTone } from "../components/ActionPanel";

export interface LinearHealth {
  connected: boolean;
  broken: boolean;
  status: GlobalStatus;
  tone: ActionTone;
  title: string;
  actionLabel: string;
  hint: string;
  description: string;
}

export function linearHealth(linear: LinearStatus): LinearHealth {
  const connected = linear.state === "connected";
  const expired = linear.state === "expired";
  const error = linear.state === "error";
  const broken = expired || error;

  if (connected) {
    return {
      connected,
      broken,
      status: "healthy",
      tone: "success",
      title: "Linear connected",
      actionLabel: "Reconnect Linear",
      hint: "Connected",
      description: "Your workspace is authorized.",
    };
  }

  if (expired) {
    return {
      connected,
      broken,
      status: "degraded",
      tone: "warning",
      title: "Linear access expired",
      actionLabel: "Reconnect Linear",
      hint: "Token expired - reconnect",
      description: "Access token expired. Reconnect to restore routing.",
    };
  }

  if (error) {
    return {
      connected,
      broken,
      status: "degraded",
      tone: "warning",
      title: "Linear connection error",
      actionLabel: "Reconnect Linear",
      hint: "Connection error - reconnect",
      description: "Connection error. Reconnect to restore routing.",
    };
  }

  return {
    connected,
    broken,
    status: "not_started",
    tone: "info",
    title: "Connect Linear",
    actionLabel: "Connect Linear",
    hint: "Not connected",
    description: "Authorize Podium to read issues from your Linear workspace.",
  };
}

export function useConnectLinear() {
  const start = useStartLinear();
  const { notify } = useToast();
  const { t } = useI18n();

  async function connect() {
    try {
      const { authorization_url } = await start.mutateAsync();
      assignLocation(authorization_url);
    } catch {
      notify(t("Couldn't start Linear connection. Try again."), "error");
    }
  }

  return {
    connect,
    isPending: start.isPending,
  };
}
