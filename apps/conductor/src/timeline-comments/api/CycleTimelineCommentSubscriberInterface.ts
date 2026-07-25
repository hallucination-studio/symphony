import type { CycleTimelineEvent } from "../../workflow-events/api/WorkflowTimelineEvents.js";
import type { WorkflowTimelineMaterializationResult } from "../../workflow-events/api/WorkflowTimelinePublisherInterface.js";

export interface CycleTimelineCommentSubscriberInterface {
  subscribe(event: CycleTimelineEvent): Promise<WorkflowTimelineMaterializationResult>;
}
