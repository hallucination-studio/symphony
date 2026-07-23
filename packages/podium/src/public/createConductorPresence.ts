import { ConductorPresenceImpl } from "../internal/conductor-presence/ConductorPresenceImpl.js";
import type { ConductorPresence } from "./ConductorPresence.js";

export function createConductorPresence(): ConductorPresence {
  return new ConductorPresenceImpl();
}
