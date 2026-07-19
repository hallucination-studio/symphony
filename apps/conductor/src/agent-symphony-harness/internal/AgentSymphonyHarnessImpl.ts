import type { AgentSymphonyHarnessInterface } from "../api/AgentSymphonyHarnessInterface.js";
import type { V3RootRunView } from "../../root-workflow/api/Models.js";
import { assessRootDispatch } from "../../root-scheduling/internal/RootDispatchAssessmentPolicy.js";
import type { RootConversationLifecycle } from "./RootConversationLifecycle.js";

export class AgentSymphonyHarnessImpl implements AgentSymphonyHarnessInterface {
  constructor(private readonly conversations: RootConversationLifecycle) {}

  assessRoot(view: V3RootRunView) {
    return assessRootDispatch(view);
  }

  claimRoot(view: V3RootRunView) {
    return this.conversations.claim(view);
  }
}
