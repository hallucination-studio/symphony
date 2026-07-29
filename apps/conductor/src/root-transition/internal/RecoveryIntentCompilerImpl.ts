import { createHash } from "node:crypto";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { workflowKindLabel } from "../../linear-gateway/api/WorkflowKindLabels.js";
import {
  humanActionRequest,
  humanActionRequestIsActive,
  humanActionRequestScope,
} from "../../human-actions/api/HumanActionSummary.js";
import { rootInputId } from "../../root-reconciliation/internal/RootInputIdentity.js";
import { hasCurrentWorkflowAttachmentProof } from "../../linear-gateway/api/CurrentWorkflowAttachmentProvenance.js";
import type {
  RecoveryIntentCompilerInterface,
  RecoveryIntentCompilerResult,
} from "../api/RecoveryIntentCompilerInterface.js";
import { findingSetIdentityDigest } from "./FindingSetIdentity.js";
import { mechanicalWriteId } from "./MechanicalWriteId.js";
import { classifyTerminalStageRecovery } from "./TerminalStageRecoveryClassification.js";

export class RecoveryIntentCompilerImpl implements RecoveryIntentCompilerInterface {
  compile(input: Parameters<RecoveryIntentCompilerInterface["compile"]>[0]): RecoveryIntentCompilerResult {
    const { command, intent, view } = input;
    if (intent.semanticGate !== command.semanticGate) return invalid("gate_mismatch");
    if (!sameIds(intent.consumedInputIds, command.pendingInputRefs.map(({ inputId }) => inputId)) ||
        intent.commentDispositions.length !== command.pendingInputRefs.filter(({ sourceKind }) =>
          sourceKind === "comment_body" || sourceKind === "comment_thread_state").length) {
      return invalid("input_disposition_invalid");
    }
    if (command.trigger === "finding_set_open" || command.subject.kind === "finding_set" ||
        command.subject.sourceKind === "finding_state") {
      if (command.trigger !== "finding_set_open" || command.subject.kind !== "finding_set" ||
          command.subject.sourceKind !== "finding_state") return invalid("purpose_incompatible");
      const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
      const cycle = view.tree.issues.find(({ issue_id }) => issue_id === command.subject.subjectId);
      const activeCycles = view.tree.issues.filter(({ issue_kind, is_archived, status_category }) =>
        issue_kind === "cycle" && !is_archived && status_category !== "completed" && status_category !== "canceled");
      if (!root || root.issue_kind !== "root" || root.status_name !== "In Progress" || root.is_archived ||
          root.parent_issue_id !== undefined || root.project_id !== view.root.projectId ||
          view.tree.root_issue_id !== root.issue_id || !cycle || cycle.issue_kind !== "cycle" ||
          cycle.parent_issue_id !== root.issue_id || cycle.project_id !== root.project_id || cycle.is_archived ||
          cycle.status_name !== "Verifying" || activeCycles.length !== 1 || activeCycles[0]?.issue_id !== cycle.issue_id) {
        return invalid("topology_invalid");
      }
      const children = view.tree.issues.filter(({ parent_issue_id, is_archived }) =>
        parent_issue_id === cycle.issue_id && !is_archived);
      const plans = children.filter(({ issue_kind }) => issue_kind === "plan");
      const works = children.filter(({ issue_kind }) => issue_kind === "work");
      const verifies = children.filter(({ issue_kind }) => issue_kind === "verify");
      const findings = children.filter(({ issue_kind, status_name }) =>
        issue_kind === "finding" && (status_name === "Todo" || status_name === "In Progress"));
      const verify = verifies[0];
      if (plans.length !== 1 || plans[0]?.status_name !== "Done" || works.length === 0 ||
          works.some(({ status_name }) => status_name !== "Done") || verifies.length !== 1 || !verify ||
          verify.status_name !== "Done" || !verify.labels.includes("Changes Required") ||
          !verify.description.includes("Verify Changes Required.") || findings.length === 0) {
        return invalid("topology_invalid");
      }
      const findingIds = new Set(findings.map(({ issue_id }) => issue_id));
      const validTargets = new Set([verify.issue_id, ...works.map(({ issue_id }) => issue_id)]);
      const relations = view.tree.relations.filter(({ source_issue_id, target_issue_id }) =>
        findingIds.has(source_issue_id) || findingIds.has(target_issue_id));
      const relationKeys = relations.map(({ relation_kind, source_issue_id, target_issue_id }) =>
        `${relation_kind}\0${source_issue_id}\0${target_issue_id}`);
      if (relations.some(({ relation_kind, source_issue_id, target_issue_id }) =>
        relation_kind !== "relates_to" || !findingIds.has(source_issue_id) || !validTargets.has(target_issue_id)) ||
          new Set(relationKeys).size !== relationKeys.length || findings.some((finding) =>
            !relations.some(({ source_issue_id, target_issue_id }) =>
              source_issue_id === finding.issue_id && target_issue_id === verify.issue_id))) {
        return invalid("topology_invalid");
      }
      const currentDigest = findingSetIdentityDigest({
        cycle: { issueId: cycle.issue_id, remoteVersion: cycle.remote_version },
        verify: { issueId: verify.issue_id, remoteVersion: verify.remote_version },
        findings: findings.map(({ issue_id, remote_version, status_name }) => ({
          issueId: issue_id, remoteVersion: remote_version, status: status_name,
        })),
        relations: relations.map(({ relation_kind, source_issue_id, target_issue_id }) => ({
          relationKind: relation_kind, sourceIssueId: source_issue_id, targetIssueId: target_issue_id,
        })),
      });
      if (currentDigest !== command.subject.subjectVersionOrDigest) return invalid("subject_stale");
      const actorCurrent = [verify, ...findings].every((issue) => view.tree.source_manifest.some((source) =>
        source.source_kind === "linear_issue" && source.source_id === issue.issue_id &&
        source.source_version === issue.remote_version && source.actor_kind === "symphony"));
      if (!actorCurrent) return invalid("topology_invalid");
      if (intent.intent.kind === "end_current_cycle") {
        const canceled = uniqueStatus(view.tree, "Canceled");
        if (!canceled) return invalid("status_catalog_invalid");
        const description = renderRecoveryCycleConclusion(intent.intent.outcome, intent.intent.explanation);
        if (!description) return invalid("content_invalid");
        const outcomeLabel = intent.intent.outcome === "recovery_exhausted"
          ? "Recovery Exhausted"
          : "Recovery Abandoned";
        return {
          kind: "effect",
          command: {
            kind: "update_workflow_issue",
            writeId: mechanicalWriteId([
              root.issue_id, cycle.issue_id, cycle.remote_version, currentDigest,
              intent.intent.outcome, intent.intentId,
            ]),
            expectedProjectId: root.project_id,
            rootIssueId: root.issue_id,
            expectedRootRemoteVersion: root.remote_version,
            target: {
              targetIssueId: cycle.issue_id,
              expectedRemoteVersion: cycle.remote_version,
              expectedStatusId: cycle.status_id,
              expectedParentIssueId: root.issue_id,
              expectedIsArchived: false,
            },
            statusId: canceled.status_id,
            title: cycle.title,
            description,
            labelNames: [outcomeLabel, workflowKindLabel("cycle")],
            parentAssignment: { mode: "retain" },
            order: cycle.order,
          },
        };
      }
      if (intent.intent.kind === "resolve_finding_waiver") {
        if (intent.intent.resolution !== "accepted" || intent.commentDispositions.length !== 1 ||
            intent.commentDispositions[0]?.kind !== "applied") return invalid("purpose_incompatible");
        const disposition = intent.commentDispositions[0];
        const reply = view.tree.comments.find(({ comment_id }) => comment_id === disposition.source.commentId);
        const identified = reply ? humanActionRequest(view.tree, root.issue_id, reply) : undefined;
        const scope = identified ? humanActionRequestScope(identified.request) : undefined;
        const expectedTargets = findings.map(({ identifier }) => identifier).sort(compareCodePoints);
        const expectedContext = [verify.identifier, cycle.identifier].sort(compareCodePoints);
        const actualTargets = scope?.targetIdentifiers.slice().sort(compareCodePoints);
        const actualContext = scope?.contextIdentifiers.slice().sort(compareCodePoints);
        const replyDigest = reply ? createHash("sha256").update(reply.body, "utf8").digest("hex") : undefined;
        const requestCurrent = identified && view.tree.source_manifest.some(({ source_kind, source_id, source_version, actor_kind }) =>
          source_kind === "linear_comment" && source_id === identified.request.comment_id &&
          source_version === identified.request.remote_version && actor_kind === "symphony");
        const replyCurrent = reply && view.tree.source_manifest.some(({ source_kind, source_id, source_version, actor_kind }) =>
          source_kind === "linear_comment" && source_id === reply.comment_id &&
          source_version === reply.remote_version && actor_kind === "human");
        const authorizedUserId = reply?.author_user_id;
        if (!reply || !identified || identified.actionKind !== "finding_waiver" || !scope ||
            !humanActionRequestIsActive(view.tree, identified.request) || !requestCurrent || !replyCurrent ||
            reply.parent_comment_id !== identified.request.comment_id || reply.thread_root_comment_id !== identified.request.comment_id ||
            reply.author_kind !== "human" || !authorizedUserId || reply.author_id !== authorizedUserId ||
            (root.creator_user_id !== authorizedUserId && root.assignee_user_id !== authorizedUserId) ||
            disposition.source.kind !== "comment_body" || disposition.source.commentBodyDigest !== replyDigest ||
            disposition.sourceInputId !== rootInputId(`comment_body:${reply.comment_id}`, disposition.source.commentBodyDigest) ||
            !sameIds(actualTargets ?? [], expectedTargets) || !sameIds(actualContext ?? [], expectedContext)) {
          return invalid("purpose_incompatible");
        }
        return {
          kind: "comment_adoption_request",
          operationId: mechanicalWriteId([
            root.issue_id, cycle.issue_id, currentDigest, identified.request.comment_id, reply.comment_id, intent.intentId,
          ]),
          disposition,
        };
      }
      if (intent.intent.kind !== "request_human_decision" || intent.intent.decisionKind !== "waiver") {
        return invalid("purpose_incompatible");
      }
      const targetIssueIds = findings.map(({ issue_id }) => issue_id).sort(compareCodePoints);
      return {
        kind: "human_action_request",
        operationId: mechanicalWriteId([
          root.issue_id, cycle.issue_id, currentDigest, "finding-set-waiver", intent.intentId,
        ]),
        request: {
          actionKind: "finding_waiver",
          targetIssueIds,
          question: intent.intent.question,
          context: intent.intent.context,
          options: intent.intent.options,
          evidenceRefs: intent.evidenceRefs,
        },
      };
    }
    if (command.subject.kind === "delivery" || command.subject.sourceKind === "remote_scm") {
      if (command.subject.kind !== "delivery" || command.subject.sourceKind !== "remote_scm" ||
          !command.trigger.startsWith("delivery_") ||
          input.observedExternalSubject?.subjectId !== command.subject.subjectId ||
          input.observedExternalSubject.subjectVersionOrDigest !== command.subject.subjectVersionOrDigest) {
        return invalid("subject_stale");
      }
      const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
      const reference = view.tree.attachments.find(({ attachment_id }) => attachment_id === command.subject.subjectId);
      const authorizedReference = reference && hasCurrentWorkflowAttachmentProof({ tree: view.tree, attachment: reference });
      if (!root || root.issue_kind !== "root" || root.status_name !== "In Review" || root.is_archived ||
          root.parent_issue_id !== undefined || root.project_id !== view.root.projectId ||
          view.tree.root_issue_id !== root.issue_id || reference?.issue_id !== root.issue_id || !authorizedReference) {
        return invalid("topology_invalid");
      }
      if (intent.intent.kind === "continue_with_successor_attempt") {
        const cycles = view.tree.issues
          .filter(({ issue_kind, parent_issue_id }) => issue_kind === "cycle" && parent_issue_id === root.issue_id)
          .sort((left, right) => left.created_at.localeCompare(right.created_at) || compareCodePoints(left.issue_id, right.issue_id));
        const succeeded = cycles.filter((cycle) => !cycle.is_archived && cycle.status_name === "Succeeded");
        const nonterminal = cycles.filter((cycle) => !cycle.is_archived &&
          cycle.status_category !== "completed" && cycle.status_category !== "canceled");
        if (succeeded.length !== 1 || nonterminal.length !== 0) return invalid("topology_invalid");
        const planning = uniqueStatus(view.tree, "Planning");
        if (!planning) return invalid("status_catalog_invalid");
        return {
          kind: "effect",
          command: {
            kind: "create_workflow_issue",
            writeId: mechanicalWriteId([
              root.issue_id, command.subject.subjectId, command.subject.subjectVersionOrDigest,
              "delivery-recovery-successor", intent.intentId,
            ]),
            expectedProjectId: root.project_id,
            rootIssueId: root.issue_id,
            expectedRootRemoteVersion: root.remote_version,
            parentExpectedRemoteVersion: root.remote_version,
            parentExpectedStatusId: root.status_id,
            parentIssueId: root.issue_id,
            title: `Cycle ${cycles.length + 1}`,
            description: renderDeliveryRecoveryCycle(intent.intent.attemptGoal, intent.intent.successEvidenceRequirements),
            statusId: planning.status_id,
            labelNames: ["Delivery Recovery", workflowKindLabel("cycle")],
          },
        };
      }
      if (intent.intent.kind !== "request_human_decision" || intent.intent.decisionKind === "waiver") {
        return invalid("purpose_incompatible");
      }
      return {
        kind: "human_action_request",
        operationId: mechanicalWriteId([root.issue_id, command.subject.subjectId, "delivery-recovery-decision", intent.intentId]),
        request: {
          actionKind: intent.intent.decisionKind,
          targetIssueIds: [root.issue_id],
          question: intent.intent.question,
          context: intent.intent.context,
          options: intent.intent.options,
          evidenceRefs: intent.evidenceRefs,
        },
      };
    }
    if (command.trigger.startsWith("stage_") || command.subject.kind === "stage_attempt") {
      const terminalTrigger = command.trigger === "stage_blocked" || command.trigger === "stage_failed" ||
        command.trigger === "stage_inconclusive";
      if ((!terminalTrigger && command.trigger !== "stage_interrupted") || command.subject.kind !== "stage_attempt" ||
          command.subject.sourceKind !== "stage_result") {
        return invalid("purpose_incompatible");
      }
      const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
      const stage = view.tree.issues.find(({ issue_id }) => issue_id === command.subject.subjectId);
      if (!stage || stage.remote_version !== command.subject.subjectVersionOrDigest) {
        return invalid("subject_stale");
      }
      const cycle = stage.parent_issue_id
        ? view.tree.issues.find(({ issue_id }) => issue_id === stage.parent_issue_id)
        : undefined;
      const activeCycles = view.tree.issues.filter(({ issue_kind, is_archived, status_category }) =>
        issue_kind === "cycle" && !is_archived && status_category !== "completed" && status_category !== "canceled");
      const stageKind = stage.issue_kind === "plan" || stage.issue_kind === "work" || stage.issue_kind === "verify"
        ? stage.issue_kind
        : undefined;
      const expectedCycleStatus = stageKind === "plan"
        ? "Planning"
        : stageKind === "work"
          ? "Executing"
          : stageKind === "verify"
            ? "Verifying"
            : undefined;
      if (!root || root.issue_kind !== "root" || root.status_name !== "In Progress" || root.is_archived ||
          root.parent_issue_id !== undefined || root.project_id !== view.root.projectId ||
          view.tree.root_issue_id !== root.issue_id || activeCycles.length !== 1 ||
          !cycle || activeCycles[0]?.issue_id !== cycle.issue_id || cycle.issue_kind !== "cycle" ||
          cycle.parent_issue_id !== root.issue_id || cycle.project_id !== root.project_id ||
          cycle.status_name !== expectedCycleStatus ||
          !stageKind || stage.project_id !== root.project_id || stage.is_archived ||
          !stage.labels.includes(workflowKindLabel(stageKind))) {
        return invalid("topology_invalid");
      }
      const activeCycleChildren = view.tree.issues.filter(({ parent_issue_id, is_archived }) =>
        parent_issue_id === cycle.issue_id && !is_archived);
      if (terminalTrigger) {
        const actorCurrent = view.tree.source_manifest.some(({ source_kind, source_id, source_version, actor_kind }) =>
          source_kind === "linear_issue" && source_id === stage.issue_id && source_version === stage.remote_version &&
          actor_kind === "symphony");
        if (!actorCurrent || classifyTerminalStageRecovery({
          role: stageKind, status: stage.status_name, description: stage.description, labels: stage.labels,
        }) !== command.trigger ||
            !hasTerminalStageDag(activeCycleChildren, stageKind, stage.issue_id)) return invalid("topology_invalid");
        if (intent.intent.kind !== "request_human_decision" || intent.intent.decisionKind === "waiver") {
          return invalid("purpose_incompatible");
        }
        return {
          kind: "human_action_request",
          operationId: mechanicalWriteId([
            root.issue_id, stage.issue_id, stage.remote_version, command.trigger, "terminal-stage-decision", intent.intentId,
          ]),
          request: {
            actionKind: intent.intent.decisionKind,
            targetIssueIds: [stage.issue_id],
            question: intent.intent.question,
            context: intent.intent.context,
            options: intent.intent.options,
            evidenceRefs: intent.evidenceRefs,
          },
        };
      }
      if (stage.status_name !== "Interrupted" || stage.status_category !== "canceled") return invalid("topology_invalid");
      if (stageKind === "plan" && (activeCycleChildren.length !== 1 ||
          activeCycleChildren[0]?.issue_id !== stage.issue_id || view.tree.relations.some(({ source_issue_id, target_issue_id }) =>
            source_issue_id === cycle.issue_id || target_issue_id === cycle.issue_id ||
            source_issue_id === stage.issue_id || target_issue_id === stage.issue_id))) {
        return invalid("topology_invalid");
      }
      if ((stageKind === "work" || stageKind === "verify") &&
          !hasInterruptedExecutionDag(activeCycleChildren, stageKind, stage.issue_id)) {
        return invalid("topology_invalid");
      }
      if (intent.intent.kind === "end_current_cycle") {
        const canceled = uniqueStatus(view.tree, "Canceled");
        if (!canceled) return invalid("status_catalog_invalid");
        const description = renderRecoveryCycleConclusion(intent.intent.outcome, intent.intent.explanation);
        if (!description) return invalid("content_invalid");
        const outcomeLabel = intent.intent.outcome === "recovery_exhausted"
          ? "Recovery Exhausted"
          : "Recovery Abandoned";
        return {
          kind: "effect",
          command: {
            kind: "update_workflow_issue",
            writeId: mechanicalWriteId([
              root.issue_id, cycle.issue_id, cycle.remote_version, stage.issue_id, stage.remote_version,
              intent.intent.outcome, intent.intentId,
            ]),
            expectedProjectId: root.project_id,
            rootIssueId: root.issue_id,
            expectedRootRemoteVersion: root.remote_version,
            target: {
              targetIssueId: cycle.issue_id,
              expectedRemoteVersion: cycle.remote_version,
              expectedStatusId: cycle.status_id,
              expectedParentIssueId: root.issue_id,
              expectedIsArchived: false,
            },
            statusId: canceled.status_id,
            title: cycle.title,
            description,
            labelNames: [outcomeLabel, workflowKindLabel("cycle")],
            parentAssignment: { mode: "retain" },
            order: cycle.order,
          },
        };
      }
      if (intent.intent.kind === "replan_current_cycle") {
        const todo = uniqueStatus(view.tree, "Todo");
        if (!todo) return invalid("status_catalog_invalid");
        const description = renderCycleReplan(
          stageKind,
          intent.intent.planningObjective,
          intent.intent.preservedConstraints,
        );
        if (!description) return invalid("content_invalid");
        return {
          kind: "effect",
          command: {
            kind: "create_workflow_issue",
            writeId: mechanicalWriteId([
              root.issue_id, cycle.issue_id, stage.issue_id, stage.remote_version,
              "cycle-replan", intent.intentId,
            ]),
            expectedProjectId: root.project_id,
            rootIssueId: root.issue_id,
            expectedRootRemoteVersion: root.remote_version,
            parentExpectedRemoteVersion: cycle.remote_version,
            parentExpectedStatusId: cycle.status_id,
            parentIssueId: cycle.issue_id,
            title: "Plan",
            description,
            statusId: todo.status_id,
            labelNames: ["Cycle Replan", workflowKindLabel("plan")],
          },
        };
      }
      if (intent.intent.kind === "repair_current_cycle") {
        if (stageKind === "plan") return invalid("purpose_incompatible");
        const todo = uniqueStatus(view.tree, "Todo");
        if (!todo) return invalid("status_catalog_invalid");
        const description = renderCycleRepair(
          stageKind,
          intent.intent.repairObjective,
          intent.intent.acceptanceFocus,
        );
        if (!description) return invalid("content_invalid");
        return {
          kind: "effect",
          command: {
            kind: "create_workflow_issue",
            writeId: mechanicalWriteId([
              root.issue_id, cycle.issue_id, stage.issue_id, stage.remote_version,
              "cycle-repair", intent.intentId,
            ]),
            expectedProjectId: root.project_id,
            rootIssueId: root.issue_id,
            expectedRootRemoteVersion: root.remote_version,
            parentExpectedRemoteVersion: cycle.remote_version,
            parentExpectedStatusId: cycle.status_id,
            parentIssueId: cycle.issue_id,
            title: "Repair Work",
            description,
            statusId: todo.status_id,
            labelNames: ["Cycle Repair", workflowKindLabel("work")],
            order: Math.max(...activeCycleChildren.map(({ order }) => order), 0) + 1,
          },
        };
      }
      if (intent.intent.kind !== "request_human_decision" || intent.intent.decisionKind === "waiver") {
        if (stageKind === "plan" && intent.intent.kind === "continue_with_successor_attempt") {
          const todo = uniqueStatus(view.tree, "Todo");
          if (!todo) return invalid("status_catalog_invalid");
          const description = renderInterruptedPlanSuccessor(
            intent.intent.attemptGoal,
            intent.intent.successEvidenceRequirements,
          );
          if (!description) return invalid("content_invalid");
          return {
            kind: "effect",
            command: {
              kind: "create_workflow_issue",
              writeId: mechanicalWriteId([
                root.issue_id, cycle.issue_id, stage.issue_id, stage.remote_version,
                "interrupted-plan-successor", intent.intentId,
              ]),
              expectedProjectId: root.project_id,
              rootIssueId: root.issue_id,
              expectedRootRemoteVersion: root.remote_version,
              parentExpectedRemoteVersion: cycle.remote_version,
              parentExpectedStatusId: cycle.status_id,
              parentIssueId: cycle.issue_id,
              title: "Plan",
              description,
              statusId: todo.status_id,
              labelNames: ["Interrupted Plan Successor", workflowKindLabel("plan")],
            },
          };
        }
        if ((stageKind === "work" || stageKind === "verify") &&
            intent.intent.kind === "continue_with_successor_attempt") {
          const planning = uniqueStatus(view.tree, "Planning");
          if (!planning) return invalid("status_catalog_invalid");
          const description = renderInterruptedExecutionSuccessor(
            stageKind,
            intent.intent.attemptGoal,
            intent.intent.successEvidenceRequirements,
          );
          if (!description) return invalid("content_invalid");
          const cycles = view.tree.issues.filter(({ issue_kind, parent_issue_id }) =>
            issue_kind === "cycle" && parent_issue_id === root.issue_id);
          return {
            kind: "effect",
            command: {
              kind: "create_workflow_issue",
              writeId: mechanicalWriteId([
                root.issue_id, cycle.issue_id, stage.issue_id, stage.remote_version,
                "interrupted-stage-successor-cycle", intent.intentId,
              ]),
              expectedProjectId: root.project_id,
              rootIssueId: root.issue_id,
              expectedRootRemoteVersion: root.remote_version,
              parentExpectedRemoteVersion: root.remote_version,
              parentExpectedStatusId: root.status_id,
              parentIssueId: root.issue_id,
              title: `Cycle ${cycles.length + 1}`,
              description,
              statusId: planning.status_id,
              labelNames: ["Interrupted Stage Recovery", workflowKindLabel("cycle")],
            },
          };
        }
        return invalid("purpose_incompatible");
      }
      return {
        kind: "human_action_request",
        operationId: mechanicalWriteId([
          root.issue_id, stage.issue_id, stage.remote_version, "interrupted-stage-decision", intent.intentId,
        ]),
        request: {
          actionKind: intent.intent.decisionKind,
          targetIssueIds: [stage.issue_id],
          question: intent.intent.question,
          context: intent.intent.context,
          options: intent.intent.options,
          evidenceRefs: intent.evidenceRefs,
        },
      };
    }
    if (command.trigger !== "execution_generation_invalidated" ||
        command.subject.kind !== "execution_generation" ||
        command.subject.sourceKind !== "mechanical_convergence" ||
        intent.intent.kind !== "continue_with_successor_attempt") {
      return invalid("purpose_incompatible");
    }
    if (view.worktreeGate.kind !== "execution_generation_invalid" ||
        command.subject.subjectVersionOrDigest !== digest(view.worktreeGate)) {
      return invalid("subject_stale");
    }
    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    const cycle = view.tree.issues.find(({ issue_id }) => issue_id === command.subject.subjectId);
    if (!root || root.issue_kind !== "root" || root.is_archived || root.parent_issue_id !== undefined ||
        root.project_id !== view.root.projectId || view.tree.root_issue_id !== root.issue_id ||
        !cycle || cycle.issue_kind !== "cycle" || cycle.parent_issue_id !== root.issue_id || cycle.is_archived ||
        cycle.project_id !== root.project_id) {
      return invalid("topology_invalid");
    }
    if (cycle.status_name === "Canceled" && cycle.labels.includes("Execution Invalidated")) {
      return { kind: "satisfied" };
    }
    const canceled = uniqueStatus(view.tree, "Canceled");
    if (!canceled) return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      command: {
        kind: "update_workflow_issue",
        writeId: mechanicalWriteId([root.issue_id, cycle.issue_id, "invalidate-execution-generation"]),
        expectedProjectId: root.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        target: {
          targetIssueId: cycle.issue_id,
          expectedRemoteVersion: cycle.remote_version,
          expectedStatusId: cycle.status_id,
          expectedParentIssueId: root.issue_id,
          expectedIsArchived: false,
        },
        statusId: canceled.status_id,
        title: cycle.title,
        description: cycle.description,
        labelNames: [...new Set([...cycle.labels, "Execution Invalidated"])].sort(compareCodePoints),
        parentAssignment: { mode: "retain" },
        order: cycle.order,
      },
    };
  }
}

function hasInterruptedExecutionDag(
  issues: LinearWorkflowTreeSnapshot["issues"],
  stageKind: "work" | "verify",
  stageIssueId: string,
): boolean {
  const plans = issues.filter(({ issue_kind }) => issue_kind === "plan");
  const works = issues.filter(({ issue_kind }) => issue_kind === "work");
  const verifies = issues.filter(({ issue_kind }) => issue_kind === "verify");
  if (plans.length !== 1 || plans[0]?.status_name !== "Done" || works.length === 0 || verifies.length !== 1) return false;
  if (stageKind === "work") {
    return works.filter(({ status_name }) => status_name === "Interrupted").length === 1 &&
      works.some(({ issue_id, status_name }) => issue_id === stageIssueId && status_name === "Interrupted") &&
      works.every(({ status_name }) => ["Todo", "Done", "Interrupted"].includes(status_name)) &&
      verifies[0]?.status_name === "Todo";
  }
  return verifies[0]?.issue_id === stageIssueId && verifies[0].status_name === "Interrupted" &&
    works.every(({ status_name }) => status_name === "Done");
}

function hasTerminalStageDag(
  issues: LinearWorkflowTreeSnapshot["issues"],
  stageKind: "plan" | "work" | "verify",
  stageIssueId: string,
): boolean {
  const plans = issues.filter(({ issue_kind }) => issue_kind === "plan");
  const works = issues.filter(({ issue_kind }) => issue_kind === "work");
  const verifies = issues.filter(({ issue_kind }) => issue_kind === "verify");
  if (stageKind === "plan") return issues.length === 1 && plans[0]?.issue_id === stageIssueId;
  if (plans.length !== 1 || plans[0]?.status_name !== "Done" || works.length === 0 || verifies.length !== 1) return false;
  if (stageKind === "work") {
    return works.filter(({ status_name }) => status_name === "Failed").length === 1 &&
      works.some(({ issue_id, status_name }) => issue_id === stageIssueId && status_name === "Failed") &&
      works.every(({ status_name }) => ["Todo", "Done", "Failed"].includes(status_name)) &&
      verifies[0]?.status_name === "Todo";
  }
  return verifies[0]?.issue_id === stageIssueId && ["Done", "Failed"].includes(verifies[0].status_name) &&
    works.every(({ status_name }) => status_name === "Done");
}

function uniqueStatus(tree: LinearWorkflowTreeSnapshot, name: string) {
  const matches = tree.status_catalog.filter((status) => status.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function renderDeliveryRecoveryCycle(attemptGoal: string, successEvidenceRequirements: string[]): string {
  return [
    "# Recovery Goal",
    "",
    attemptGoal.trim(),
    "",
    "## Recovery Source",
    "",
    "Remote delivery changes were requested.",
    "",
    "## Success Evidence",
    "",
    ...successEvidenceRequirements.map((requirement) => `- ${requirement.trim()}`),
  ].join("\n");
}

function renderInterruptedPlanSuccessor(attemptGoal: string, successEvidenceRequirements: string[]): string | undefined {
  const goal = attemptGoal.trim();
  const requirements = successEvidenceRequirements.map((requirement) => requirement.trim());
  if (!goal || requirements.length === 0 || requirements.some((requirement) => !requirement)) return undefined;
  const description = [
    "# Recovery Goal", "", goal, "",
    "## Recovery Source", "", "The predecessor Plan attempt was interrupted.", "",
    "## Success Evidence", "", ...requirements.map((requirement) => `- ${requirement}`),
  ].join("\n");
  return description.length <= 16_384 ? description : undefined;
}

function renderInterruptedExecutionSuccessor(
  stageKind: "work" | "verify",
  attemptGoal: string,
  successEvidenceRequirements: string[],
): string | undefined {
  const goal = attemptGoal.trim();
  const requirements = successEvidenceRequirements.map((requirement) => requirement.trim());
  if (!goal || requirements.length === 0 || requirements.some((requirement) => !requirement)) return undefined;
  const description = [
    "# Recovery Goal", "", goal, "",
    "## Recovery Source", "", `The predecessor Cycle contains an interrupted ${stageKind} attempt.`, "",
    "## Success Evidence", "", ...requirements.map((requirement) => `- ${requirement}`),
  ].join("\n");
  return description.length <= 16_384 ? description : undefined;
}

function renderRecoveryCycleConclusion(
  outcome: "recovery_exhausted" | "recovery_abandoned",
  explanation: string,
): string | undefined {
  const normalized = explanation.trim();
  if (!normalized) return undefined;
  const description = [
    "# Recovery Conclusion", "", normalized, "",
    "## Outcome", "", outcome,
  ].join("\n");
  return description.length <= 16_384 ? description : undefined;
}

function renderCycleReplan(
  stageKind: "plan" | "work" | "verify",
  planningObjective: string,
  preservedConstraints: string[],
): string | undefined {
  const objective = planningObjective.trim();
  const constraints = preservedConstraints.map((constraint) => constraint.trim());
  if (!objective || constraints.length === 0 || constraints.some((constraint) => !constraint)) return undefined;
  const description = [
    "# Replan Objective", "", objective, "",
    "## Recovery Source", "", `The current Cycle contains an interrupted ${stageKind} attempt.`, "",
    "## Preserved Constraints", "", ...constraints.map((constraint) => `- ${constraint}`),
  ].join("\n");
  return description.length <= 16_384 ? description : undefined;
}

function renderCycleRepair(
  stageKind: "work" | "verify",
  repairObjective: string,
  acceptanceFocus: string[],
): string | undefined {
  const objective = repairObjective.trim();
  const focus = acceptanceFocus.map((item) => item.trim());
  if (!objective || focus.length === 0 || focus.some((item) => !item)) return undefined;
  const description = [
    "# Repair Objective", "", objective, "",
    "## Recovery Source", "", `The current Cycle contains an interrupted ${stageKind} attempt.`, "",
    "## Acceptance Focus", "", ...focus.map((item) => `- ${item}`),
  ].join("\n");
  return description.length <= 16_384 ? description : undefined;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort(compareCodePoints)
    .every((value, index) => value === [...right].sort(compareCodePoints)[index]);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(reason: Extract<RecoveryIntentCompilerResult, { kind: "invalid_intent" }>["reason"]): RecoveryIntentCompilerResult {
  return { kind: "invalid_intent", reason };
}
