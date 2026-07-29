import type { LinearObservation } from "../contracts/observation.js";
import type { LinearGatewayInterface, RootCandidate } from "../linear/api/LinearGatewayInterface.js";

export interface RootAdmission {
  readonly candidate: RootCandidate;
  readonly observation: LinearObservation;
}

export class RootDiscovery {
  constructor(private readonly linear: LinearGatewayInterface) {}

  async nextExecutable(): Promise<RootAdmission | null> {
    const candidates = await this.linear.discoverRoots();
    for (const candidate of candidates) {
      if (candidate.status === "In Review" || candidate.status === "Done") continue;
      const observation = await this.linear.readRoot(candidate.root_id);
      if (observation.root_id !== candidate.root_id) {
        throw new Error("root_admission_identity_mismatch");
      }
      if (observation.root_status !== candidate.status) {
        throw new Error("root_admission_facts_changed");
      }
      return Object.freeze({ candidate, observation });
    }
    return null;
  }
}
