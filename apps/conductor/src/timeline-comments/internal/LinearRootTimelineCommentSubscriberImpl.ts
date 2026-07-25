import type { LinearGatewayInterface } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootTimelineEvent } from "../../workflow-events/api/WorkflowTimelineEvents.js";
import type { WorkflowTimelineMaterializationResult } from "../../workflow-events/api/WorkflowTimelinePublisherInterface.js";
import type { RootTimelineCommentSubscriberInterface } from "../api/RootTimelineCommentSubscriberInterface.js";
import { materializeRootTimelineComment } from "./LinearTimelineCommentMaterializer.js";

export class LinearRootTimelineCommentSubscriberImpl implements RootTimelineCommentSubscriberInterface {
  constructor(private readonly linear: LinearGatewayInterface) {}

  subscribe(event: RootTimelineEvent): Promise<WorkflowTimelineMaterializationResult> {
    return materializeRootTimelineComment(this.linear, event);
  }
}
