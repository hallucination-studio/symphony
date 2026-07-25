import type { CycleTimelineCommentSubscriberInterface } from "../../timeline-comments/api/CycleTimelineCommentSubscriberInterface.js";
import type { RootTimelineCommentSubscriberInterface } from "../../timeline-comments/api/RootTimelineCommentSubscriberInterface.js";
import type { WorkflowTimelineEvent } from "../api/WorkflowTimelineEvents.js";
import type {
  WorkflowTimelineMaterializationResult,
  WorkflowTimelinePublisherInterface,
} from "../api/WorkflowTimelinePublisherInterface.js";

export class InProcessWorkflowTimelinePublisherImpl implements WorkflowTimelinePublisherInterface {
  constructor(
    private readonly rootSubscriber: RootTimelineCommentSubscriberInterface,
    private readonly cycleSubscriber: CycleTimelineCommentSubscriberInterface,
  ) {}

  publish(event: WorkflowTimelineEvent): Promise<WorkflowTimelineMaterializationResult> {
    return event.timelineKind === "root"
      ? this.rootSubscriber.subscribe(event)
      : this.cycleSubscriber.subscribe(event);
  }
}
