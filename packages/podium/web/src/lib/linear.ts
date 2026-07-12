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
  const reauthorizationRequired = linear.state === "reauthorization_required";
  const expired = linear.state === "expired";
  const error = linear.state === "error";
  const broken = reauthorizationRequired || expired || error;

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

  if (reauthorizationRequired) {
    return {
      connected,
      broken,
      status: "degraded",
      tone: "warning",
      title: "Linear authorization required",
      actionLabel: "Reauthorize Linear",
      hint: "Reauthorization required",
      description: "Reauthorize Linear to restore project polling.",
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
