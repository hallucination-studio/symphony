export const FIXED_HUMAN_RESPONSE =
  "Approved for the E2E scenario. Execute the proposed plan exactly as written.";

const PLAN_APPROVAL_TITLE = "[Human Action] Approve Plan";
const PLAN_APPROVAL_DESCRIPTION = (rootIssueId) =>
  `Approve the plan before work begins.\n\n<!-- symphony managed marker\nmanaged_marker: ${rootIssueId}:plan-approval\nkind: human\nhuman_kind: plan_approval\ntarget_issue_id: none\n-->`;

export function createHumanActor({ linear, response = FIXED_HUMAN_RESPONSE } = {}) {
  if (!linear || typeof linear.readManagedHuman !== "function" ||
      typeof linear.postHumanResponse !== "function" ||
      typeof linear.completeHuman !== "function") {
    throw new Error("e2e_human_actor_boundary_invalid");
  }
  if (response !== FIXED_HUMAN_RESPONSE) throw new Error("e2e_human_response_invalid");

  return Object.freeze({
    async respondAndComplete({ lock, runId, fixture, doneStateId } = {}) {
      const human = await linear.readManagedHuman({ lock, runId, fixture });
      assertManagedHuman(human, fixture);
      const expectedRemoteVersion = human.remoteVersion;
      await linear.postHumanResponse({
        lock,
        runId,
        fixture,
        human,
        body: response,
        expectedRemoteVersion,
      });
      await linear.completeHuman({
        lock,
        runId,
        fixture,
        human,
        expectedRemoteVersion,
        doneStateId,
      });
      const readBack = await linear.readManagedHuman({ lock, runId, fixture });
      if (readBack?.state !== "Done" ||
          !readBack.comments?.some(({ body }) => body === response)) {
        throw new Error("e2e_human_response_readback_invalid");
      }
      return Object.freeze({ issueId: readBack.issueId, state: readBack.state });
    },
  });
}

function assertManagedHuman(human, fixture) {
  if (
    !human ||
    human.issueId === undefined ||
    human.rootIssueId !== fixture?.rootId ||
    human.projectId !== fixture?.projectId ||
    human.parentIssueId !== fixture.rootId ||
    human.title !== PLAN_APPROVAL_TITLE ||
    human.description !== PLAN_APPROVAL_DESCRIPTION(fixture.rootId) ||
    human.managedMarker !== `${fixture.rootId}:plan-approval` ||
    human.kind !== "human" ||
    human.humanKind !== "plan_approval" ||
    !["Todo", "In Progress"].includes(human.state) ||
    typeof human.remoteVersion !== "string" ||
    human.remoteVersion.length === 0
  ) {
    throw new Error("e2e_human_child_invalid");
  }
}
