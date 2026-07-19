import type {
  RootDispatchAssessment,
  V3RootRunView,
} from "../../root-workflow/api/Models.js";
import type { RootClaimResult } from "../internal/RootConversationLifecycle.js";
import type { RunAgentRootTurnResult } from "../internal/RunAgentRootTurnUseCase.js";

export interface AgentSymphonyHarnessInterface {
  assessRoot(view: V3RootRunView): RootDispatchAssessment;
  claimRoot(view: V3RootRunView): Promise<RootClaimResult>;
  runRootTurn(rootIssueId: string): Promise<RunAgentRootTurnResult>;
}
