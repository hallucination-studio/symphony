import type { RootSchedulingResult } from "../../root-scheduling/api/RootSchedulingPolicyInterface.js";
import type {
  AcceptedProjectRootIndex,
  ProjectRootHeader,
  ProjectRootIndexFailure,
} from "./ProjectRootIndexRecoveryInterface.js";

export type ProjectRootCandidateRoundResult =
  | {
      kind: "ready";
      index: AcceptedProjectRootIndex;
      selected: readonly ProjectRootHeader[];
      blocked: RootSchedulingResult<ProjectRootHeader>["blocked"];
    }
  | { kind: "recovery_required"; failure: ProjectRootIndexFailure };

export interface ProjectRootCandidateRoundInterface {
  next(): Promise<ProjectRootCandidateRoundResult>;
}
