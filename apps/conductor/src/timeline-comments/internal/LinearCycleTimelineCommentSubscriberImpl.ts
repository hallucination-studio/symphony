import type { LinearGatewayInterface } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { CycleTimelineEvent } from "../../workflow-events/api/WorkflowTimelineEvents.js";
import type { WorkflowTimelineMaterializationResult } from "../../workflow-events/api/WorkflowTimelinePublisherInterface.js";
import type { CycleTimelineCommentSubscriberInterface } from "../api/CycleTimelineCommentSubscriberInterface.js";
import { materializeCycleTimelineComment } from "./LinearTimelineCommentMaterializer.js";

export class LinearCycleTimelineCommentSubscriberImpl implements CycleTimelineCommentSubscriberInterface {
  constructor(private readonly linear: LinearGatewayInterface) {}

  subscribe(event: CycleTimelineEvent): Promise<WorkflowTimelineMaterializationResult> {
    return materializeCycleTimelineComment(this.linear, event);
  }
}
