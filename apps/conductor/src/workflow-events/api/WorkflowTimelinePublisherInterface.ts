import type { WorkflowTimelineEvent } from "./WorkflowTimelineEvents.js";

export type WorkflowTimelineMaterializationResult =
  | { kind: "materialized"; timelineEventId: string; commentId: string }
  | { kind: "failed"; timelineEventId: string; code: string; sanitizedReason: string };

export interface WorkflowTimelinePublisherInterface {
  publish(event: WorkflowTimelineEvent): Promise<WorkflowTimelineMaterializationResult>;
}
