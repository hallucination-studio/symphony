import type { LinearStatus } from "../api/types";
import type { GlobalStatus } from "./format";

export interface LinearHealth {
  status: GlobalStatus;
  hint: string;
}

export function linearHealth(linear: LinearStatus): LinearHealth {
  if (linear.state === "connected") {
    return {
      status: "healthy",
      hint: "Connected",
    };
  }

  if (linear.state === "reauthorization_required") {
    return {
      status: "degraded",
      hint: "Reauthorization required",
    };
  }

  if (linear.state === "expired") {
    return {
      status: "degraded",
      hint: "Token expired - reconnect",
    };
  }

  if (linear.state === "error") {
    return {
      status: "degraded",
      hint: "Connection error - reconnect",
    };
  }

  return {
    status: "not_started",
    hint: "Not connected",
  };
}
