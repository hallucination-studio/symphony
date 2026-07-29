import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCanonicalPlanDescription,
  renderCanonicalPlanDescription,
} from "../internal/CanonicalPlanDescription.js";

test("canonical Plan Markdown losslessly round-trips proposal identities and multiline facts", () => {
  const document = {
    summary: "A reviewed plan with `code` and\nmultiple lines.",
    planContract: {
      objective: "Build the exact feature.\nKeep recovery deterministic.",
      includedScope: ["runtime", "contracts"],
      excludedScope: [],
      assumptions: ["Linear timestamps are immutable."],
      constraints: ["Do not add JSON markers."],
      acceptanceCriteria: [{
        criterionKey: "criterion-1", statement: "The DAG survives restart.", verificationMethod: "Replay partial facts.",
      }],
      verificationRequirements: ["Run focused tests."],
    },
    proposedWorkDag: {
      workNodes: [
        {
          proposalKey: "contract", title: "Define contract", description: "Add the closed interface.",
          expectedOutcome: "The interface is generated.", requiredChecks: ["contract test"], dependencyProposalKeys: [],
        },
        {
          proposalKey: "runtime", title: "Compose runtime", description: "Consume the interface.",
          expectedOutcome: "Restart resumes.", requiredChecks: ["runtime test"], dependencyProposalKeys: ["contract"],
        },
      ],
      dependencyEdges: [],
      verifyNode: {
        title: "Verify the accepted DAG",
        acceptanceCriteria: [{
          criterionKey: "criterion-1", statement: "The DAG survives restart.", verificationMethod: "Replay partial facts.",
        }],
        requiredChecks: ["contract test", "runtime test"],
      },
    },
    risks: ["A user edit after approval invalidates authority."],
    requiredPermissions: [],
  };

  const rendered = renderCanonicalPlanDescription(document);
  assert.deepEqual(parseCanonicalPlanDescription(rendered), document);
  assert.doesNotMatch(rendered, /```json|<!--/u);
  assert.match(rendered, /Proposal Key/u);
});

test("canonical Plan parser rejects truncation and trailing unowned content", () => {
  const rendered = renderCanonicalPlanDescription({
    summary: "Plan.",
    planContract: {
      objective: "Build it.", includedScope: ["runtime"], excludedScope: [], assumptions: [], constraints: [],
      acceptanceCriteria: [{ criterionKey: "criterion-1", statement: "It works.", verificationMethod: "Test." }],
      verificationRequirements: [],
    },
    proposedWorkDag: {
      workNodes: [{
        proposalKey: "work-1", title: "Work", description: "Implement.", expectedOutcome: "Done.",
        requiredChecks: [], dependencyProposalKeys: [],
      }],
      dependencyEdges: [],
      verifyNode: { title: "Verify", acceptanceCriteria: [], requiredChecks: [] },
    },
    risks: [], requiredPermissions: [],
  });

  assert.throws(() => parseCanonicalPlanDescription(rendered.replace("## Verify Proposal", "## Missing Verify")),
    /plan_description_structure_invalid/u);
  assert.throws(() => parseCanonicalPlanDescription(`${rendered}\nforeign content`),
    /plan_description_trailing_content/u);
});
