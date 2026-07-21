import type {
  AcceptanceCriterion,
  CheckEvidence,
  PlanContract,
  VerifyNodeContract,
  WorkNodeContract,
} from "../../root-workflow/api/ManagedRecords.js";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const maxWorkNodes = 128;
const maxRelations = 1_024;

export interface ValidatedPlanContract {
  contract: PlanContract;
  workNodes: WorkNodeContract[];
  verifyNode: VerifyNodeContract;
  relationCount: number;
}

export class PlanContractValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PlanContractValidationError";
  }
}

export function validatePlanContract(
  contract: PlanContract,
  rootIssueId: string,
  cycleIssueId: string,
): ValidatedPlanContract {
  if (contract.kind !== "plan_contract" || contract.version !== 1) fail("plan_contract_version_invalid");
  if (contract.rootIssueId !== rootIssueId || contract.cycleIssueId !== cycleIssueId) fail("plan_contract_target_invalid");
  if (!contract.planContractDigest || contract.planContractDigest === "pending-plan-contract") fail("plan_contract_digest_invalid");
  nonEmpty(contract.objectiveSummary, "plan_contract_objective_invalid");
  nonEmptyList(contract.includedScope, "plan_contract_scope_invalid");
  strings(contract.excludedScope, "plan_contract_scope_invalid");
  criteria(contract.acceptanceCriteria, "plan_contract_acceptance_invalid");
  if (!Array.isArray(contract.workNodes) || contract.workNodes.length > maxWorkNodes) fail("plan_contract_work_nodes_invalid");

  const keys = new Set<string>();
  const dependencies = new Map<string, string[]>();
  for (const work of contract.workNodes) {
    validateWork(work);
    if (keys.has(work.workKey)) fail("plan_contract_work_key_duplicate");
    if (work.workKey === "plan-1" || work.workKey === "verify-1") fail("plan_contract_work_key_reserved");
    keys.add(work.workKey);
    if (work.dependencyWorkKeys.includes(work.workKey)) fail("plan_contract_dependency_self_cycle");
    if (new Set(work.dependencyWorkKeys).size !== work.dependencyWorkKeys.length) fail("plan_contract_dependency_duplicate");
    dependencies.set(work.workKey, [...work.dependencyWorkKeys]);
  }
  for (const values of dependencies.values()) {
    if (values.some((dependency) => !keys.has(dependency))) fail("plan_contract_dependency_unknown");
  }
  assertAcyclic(dependencies);
  validateVerify(contract.verifyNode);

  const dependencyCount = contract.workNodes.reduce((count, work) => count + work.dependencyWorkKeys.length, 0);
  const relationCount = contract.workNodes.length * 2 + dependencyCount;
  if (relationCount > maxRelations) fail("plan_contract_relation_limit");
  return { contract, workNodes: contract.workNodes.map((work) => ({ ...work, dependencyWorkKeys: [...work.dependencyWorkKeys] })), verifyNode: cloneVerify(contract.verifyNode), relationCount };
}

function validateWork(work: WorkNodeContract): void {
  if (!identifierPattern.test(work.workKey)) fail("plan_contract_work_key_invalid");
  nonEmpty(work.title, "plan_contract_work_title_invalid");
  nonEmpty(work.description, "plan_contract_work_description_invalid");
  criteria(work.acceptanceCriteria, "plan_contract_work_acceptance_invalid");
  strings(work.dependencyWorkKeys, "plan_contract_dependency_invalid");
  if (work.dependencyWorkKeys.some((dependency) => !identifierPattern.test(dependency))) fail("plan_contract_dependency_invalid");
}

function validateVerify(verify: VerifyNodeContract): void {
  nonEmpty(verify.title, "plan_contract_verify_title_invalid");
  criteria(verify.acceptanceCriteria, "plan_contract_verify_acceptance_invalid");
  if (!Array.isArray(verify.requiredChecks)) fail("plan_contract_verify_checks_invalid");
  for (const check of verify.requiredChecks) {
    if (!check || typeof check !== "object" || !identifierPattern.test(check.checkKey)
      || !check.commandOrMethod || !check.summary || !check.artifactRevision
      || !["passed", "failed", "not_run"].includes(check.outcome)) {
      fail("plan_contract_verify_checks_invalid");
    }
  }
}

function criteria(values: AcceptanceCriterion[], code: string): void {
  if (!Array.isArray(values) || values.length === 0) fail(code);
  const keys = new Set<string>();
  for (const criterion of values) {
    if (!criterion || !identifierPattern.test(criterion.criterionKey) || keys.has(criterion.criterionKey)) fail(code);
    keys.add(criterion.criterionKey);
    nonEmpty(criterion.statement, code);
    nonEmpty(criterion.verificationMethod, code);
  }
}

function strings(values: string[], code: string): void {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) fail(code);
}

function nonEmpty(value: string, code: string): void {
  if (typeof value !== "string" || value.trim().length === 0) fail(code);
}

function nonEmptyList(values: string[], code: string): void {
  strings(values, code);
  if (values.length === 0 || values.some((value) => value.trim().length === 0)) fail(code);
}

function assertAcyclic(graph: Map<string, string[]>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) fail("plan_contract_dependency_cycle");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of graph.get(key) ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of graph.keys()) visit(key);
}

function cloneVerify(value: VerifyNodeContract): VerifyNodeContract {
  return {
    title: value.title,
    acceptanceCriteria: value.acceptanceCriteria.map((criterion) => ({ ...criterion })),
    requiredChecks: value.requiredChecks.map((check: CheckEvidence) => ({ ...check })),
  };
}

function fail(code: string): never {
  throw new PlanContractValidationError(code);
}
