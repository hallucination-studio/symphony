import { assessApprovedHappyPathEvidence } from "./approved-happy-path-evidence.mjs";

export function analyzeDeliveryReviewCampaignEvidence({ rows } = {}) {
  if (!Array.isArray(rows)) return Object.freeze({ case_outcomes: Object.freeze([]) });
  const caseOutcomes = rows
    .filter((row) => row?.e2eCase?.evidence_predicate_id === "delivery_review")
    .map((row) => {
      const assessment = assessApprovedHappyPathEvidence(row);
      return Object.freeze({
        case_id: row.e2eCase.case_id,
        outcome: assessment.outcome.kind === "satisfied"
          ? Object.freeze({ kind: "satisfied", reason_code: "delivery_review_confirmed" })
          : assessment.outcome,
      });
    });
  return Object.freeze({ case_outcomes: Object.freeze(caseOutcomes) });
}
