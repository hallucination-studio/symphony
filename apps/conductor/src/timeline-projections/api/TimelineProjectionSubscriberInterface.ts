import type { WorkflowTimelineEvent } from "../../workflow-events/api/WorkflowTimelineEvents.js";
import type { WorkflowTimelineMaterializationResult } from "../../workflow-events/api/WorkflowTimelinePublisherInterface.js";

export interface TimelineProjectionSubscriberInterface {
  project(event: WorkflowTimelineEvent): Promise<WorkflowTimelineMaterializationResult>;
}
