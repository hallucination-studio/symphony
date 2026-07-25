import type { RootTimelineEvent } from "../../workflow-events/api/WorkflowTimelineEvents.js";
import type { WorkflowTimelineMaterializationResult } from "../../workflow-events/api/WorkflowTimelinePublisherInterface.js";

export interface RootTimelineCommentSubscriberInterface {
  subscribe(event: RootTimelineEvent): Promise<WorkflowTimelineMaterializationResult>;
}
