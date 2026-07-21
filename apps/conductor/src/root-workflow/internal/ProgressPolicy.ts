export interface ProgressPolicyInput {
  resolvedFindingIds: string[];
  previousPassedCriterionKeys: string[];
  currentPassedCriterionKeys: string[];
  previousPassedCheckKeys: string[];
  currentPassedCheckKeys: string[];
}

export function assessProgress(input: ProgressPolicyInput): boolean {
  return input.resolvedFindingIds.length > 0
    || isStrictSuperset(input.currentPassedCriterionKeys, input.previousPassedCriterionKeys)
    || isStrictSuperset(input.currentPassedCheckKeys, input.previousPassedCheckKeys);
}

function isStrictSuperset(current: string[], previous: string[]): boolean {
  const currentSet = new Set(current);
  return currentSet.size > new Set(previous).size && previous.every((key) => currentSet.has(key));
}
