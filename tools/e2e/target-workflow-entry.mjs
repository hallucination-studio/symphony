import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isMissingInputConfiguration, loadE2EConfig } from "./config.mjs";
import { evaluateTargetWorkflowResults } from "./target-workflow-evidence.mjs";
import { TARGET_WORKFLOW_SCENARIOS } from "./target-workflow-verdict.mjs";
import { auditTargetWorkflowSources } from "./target-workflow-static-audit.mjs";
import {
  runTargetDeliveryLive,
  runTargetRepairLive,
  runTargetRestartLive,
  runTargetSchedulingLive,
  runTargetSuccessLive,
} from "./target-workflow-live.mjs";
import { prepareTargetWorkflowSetup } from "./target-workflow-setup.mjs";
import { createE2ELogger } from "./logging.mjs";
import { LinearRunBudgetImpl } from "@symphony/podium";

const TARGET_SCENARIO_START_COST = Object.freeze({ requests: 1, complexity: 10_000 });
const TARGET_E2E_TIMEOUT_MS = 5 * 60_000;

const TARGET_SOURCE_FILES = Object.freeze({
  runner: "tools/e2e/target-workflow-runner.mjs",
  inputs: "tools/e2e/target-workflow-inputs.mjs",
  transport: "tools/e2e/target-workflow-transport.mjs",
});

export async function runTargetWorkflowDryRun({ readSource = readFile } = {}) {
  const sources = {};
  for (const [name, file] of Object.entries(TARGET_SOURCE_FILES)) {
    sources[name] = await readSource(file, "utf8");
  }
  const staticAudit = auditTargetWorkflowSources(sources);
  if (!staticAudit.passed) throw new Error("target_entry_static_audit_failed");
  return Object.freeze({
    status: "dry_run",
    mutationAttempted: false,
    staticAudit,
    scenarios: Object.freeze(TARGET_WORKFLOW_SCENARIOS.map((scenario) => Object.freeze({
      scenario,
      status: "unverified",
    }))),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 1 || arguments_[0] !== "--dry-run") {
    if (arguments_.length === 1 && arguments_[0] === "--live-success") {
      runTargetWorkflowLive()
        .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
        .catch((error) => {
          process.stderr.write(`${JSON.stringify({
            status: isMissingInputConfiguration(error) ? "unverified" : "failed",
            reason: stableReason(error),
            ...(Array.isArray(error?.issues) ? { issues: error.issues } : {}),
          })}\n`);
          process.exitCode = 2;
        });
    } else if (arguments_.length === 1 && arguments_[0] === "--live-repair") {
      runTargetWorkflowLive("repair")
        .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
        .catch((error) => {
          process.stderr.write(`${JSON.stringify({
            status: isMissingInputConfiguration(error) ? "unverified" : "failed",
            reason: stableReason(error),
            ...(Array.isArray(error?.issues) ? { issues: error.issues } : {}),
          })}\n`);
          process.exitCode = 2;
        });
    } else if (arguments_.length === 1 && arguments_[0] === "--live-delivery") {
      runTargetWorkflowLive("delivery")
        .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
        .catch((error) => {
          process.stderr.write(`${JSON.stringify({
            status: isMissingInputConfiguration(error) ? "unverified" : "failed",
            reason: stableReason(error),
            ...(Array.isArray(error?.issues) ? { issues: error.issues } : {}),
          })}\n`);
          process.exitCode = 2;
        });
    } else if (arguments_.length === 1 && arguments_[0] === "--live-all") {
      runTargetWorkflowLive("all")
        .then((result) => {
          process.stdout.write(`${JSON.stringify(result)}\n`);
          process.exitCode = targetWorkflowCliExitCode(result);
        })
        .catch((error) => {
          process.stderr.write(`${JSON.stringify({
            status: isMissingInputConfiguration(error) ? "unverified" : "failed",
            reason: stableReason(error),
            ...(Array.isArray(error?.issues) ? { issues: error.issues } : {}),
          })}\n`);
          process.exitCode = 2;
        });
    } else {
      process.stderr.write('{"status":"failed","reason":"target_entry_argument_invalid"}\n');
      process.exitCode = 2;
    }
  } else {
    runTargetWorkflowDryRun()
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error) => {
        process.stderr.write(`${JSON.stringify({
          status: "failed",
          reason: stableReason(error),
        })}\n`);
        process.exitCode = 2;
      });
  }
}

async function runTargetWorkflowLive(scenario = "success") {
  const config = loadE2EConfig();
  if (!config.linear.projectSlugId) {
    const error = new Error("e2e_configuration_invalid");
    error.code = "e2e_configuration_invalid";
    error.issues = ["target_project_slug_id_missing"];
    throw error;
  }
  const linearRunBudget = new LinearRunBudgetImpl({
    physicalRequestComplexity: config.linear.physicalRequestComplexity,
  });
  const log = createE2ELogger({
    runId: process.env.SYMPHONY_E2E_RUN_ID,
    secrets: [config.secrets.linearDevToken, config.secrets.codexApiKey],
  });
  if (scenario === "repair") return runTargetRepairLive({ config, linearRunBudget, log });
  if (scenario === "delivery") return runTargetDeliveryLive({ config, linearRunBudget, log });
  if (scenario === "restart_recovery") return runTargetRestartLive({ config, linearRunBudget, log });
  if (scenario === "scheduling") return runTargetSchedulingLive({ config, linearRunBudget, log });
  if (scenario === "all") return runTargetWorkflowAllLive({ config, linearRunBudget, log });
  return runTargetSuccessLive({ config, linearRunBudget, log });
}

export async function runTargetWorkflowAllLive({
  config,
  environment = process.env,
  fetch = globalThis.fetch,
  log = () => {},
  runScenario = defaultRunScenario,
  prepareSetup = prepareTargetWorkflowSetup,
  linearRunBudget = new LinearRunBudgetImpl(),
  timeoutMs = TARGET_E2E_TIMEOUT_MS,
  now = Date.now,
  writeEvidence = true,
  evidenceDirectory,
} = {}) {
  if (!config?.linear?.projectSlugId) throw stableError("target_all_configuration_invalid");
  if (!environment || typeof environment !== "object" || typeof runScenario !== "function" ||
      typeof prepareSetup !== "function" || typeof fetch !== "function" || typeof log !== "function" ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TARGET_E2E_TIMEOUT_MS ||
      typeof now !== "function") {
    throw stableError("target_all_input_invalid");
  }
  const deadline = now() + timeoutMs;
  const preparedSetup = await prepareSetup({
    config,
    runId: environment.SYMPHONY_E2E_RUN_ID,
    fetch,
    log,
    linearRunBudget,
  });
  const budgetEvidence = { setup: linearRunBudget.snapshot(), scenarios: {} };
  const results = [];
  for (const scenario of TARGET_WORKFLOW_SCENARIOS) {
    try {
      const remainingMs = deadline - now();
      if (remainingMs <= 0) throw stableError("target_all_timeout");
      const rootReservation = linearRunBudget.reserve(TARGET_SCENARIO_START_COST);
      rootReservation.release();
      const result = await runScenario(scenario, {
        config,
        environment,
        fetch,
        log,
        setup: preparedSetup,
        linearRunBudget,
        timeoutMs: remainingMs,
      });
      if (!result || typeof result !== "object" || result.scenario !== scenario) {
        throw stableError("target_all_scenario_result_invalid");
      }
      results.push(result);
      budgetEvidence.scenarios[scenario] = linearRunBudget.snapshot();
    } catch (error) {
      results.push(Object.freeze({
        scenario,
        status: "failed",
        reason: stableReason(error),
      }));
      budgetEvidence.scenarios[scenario] = linearRunBudget.snapshot();
    }
  }
  budgetEvidence.total = linearRunBudget.snapshot();
  const evaluated = evaluateTargetWorkflowResults({ results, cleanupCompleted: true, setup: preparedSetup, budgetEvidence }, {
    secrets: [config.secrets?.linearDevToken, config.secrets?.codexApiKey],
  });
  const result = Object.freeze({
    status: evaluated.verdict.verdict,
    runId: environment.SYMPHONY_E2E_RUN_ID,
    evidence: evaluated.evidence,
    verdict: evaluated.verdict,
    budget: linearRunBudget.snapshot(),
  });
  if (writeEvidence) await persistTargetWorkflowEvidence(result, evidenceDirectory);
  return result;
}

export function targetWorkflowCliExitCode(result) {
  if (result?.status === "passed") return 0;
  if (result?.status === "unverified") return 2;
  return 1;
}

async function persistTargetWorkflowEvidence(result, evidenceDirectory) {
  const runId = result.runId;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId ?? "")) {
    throw stableError("target_all_run_id_invalid");
  }
  const directory = evidenceDirectory ?? path.resolve(".test", "e2e-target-workflow", runId);
  if (typeof directory !== "string" || directory.length === 0) throw stableError("target_all_evidence_path_invalid");
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, "verdict.json"), `${JSON.stringify(result)}\n`, { mode: 0o600 });
  } catch {
    throw stableError("target_all_evidence_write_failed");
  }
}

async function defaultRunScenario(scenario, { setup, linearRunBudget, timeoutMs, ...input }) {
  const composed = composeTargetWorkflowScenarioInput(scenario, {
    setup,
    environment: input.environment,
  });
  const scenarioSetup = composed.setup;
  const dependencies = { prepareSetup: async () => scenarioSetup };
  const scenarioInput = {
    ...input,
    environment: composed.environment,
  };
  if (scenario === "success") return runTargetSuccessLive({ ...scenarioInput, linearRunBudget, timeoutMs, dependencies });
  if (scenario === "repair_escalation") return runTargetRepairLive({ ...scenarioInput, linearRunBudget, timeoutMs, dependencies });
  if (scenario === "restart_recovery") return runTargetRestartLive({ ...scenarioInput, linearRunBudget, timeoutMs, dependencies });
  if (scenario === "delivery") return runTargetDeliveryLive({ ...scenarioInput, linearRunBudget, timeoutMs, dependencies });
  return runTargetSchedulingLive({ ...scenarioInput, linearRunBudget, timeoutMs, dependencies });
}

export function composeTargetWorkflowScenarioInput(scenario, { setup, environment } = {}) {
  if (typeof scenario !== "string" || !environment || typeof environment.SYMPHONY_E2E_RUN_ID !== "string") {
    throw stableError("target_all_scenario_composition_invalid");
  }
  const scenarioSuffix = `-${scenario}`;
  const scenarioRunId = `${environment.SYMPHONY_E2E_RUN_ID.slice(0, 128 - scenarioSuffix.length)}${scenarioSuffix}`;
  return Object.freeze({
    setup: Object.freeze({
      ...setup,
      ...(setup?.rootInput ? {
        rootInput: Object.freeze({
          ...setup.rootInput,
          title: `${setup.rootInput.title} [${scenario}]`,
          description: `${setup.rootInput.description} Scenario correlation: ${scenarioRunId}.`,
        }),
      } : {}),
    }),
    environment: Object.freeze({ ...environment, SYMPHONY_E2E_RUN_ID: scenarioRunId }),
  });
}

function stableReason(error) {
  return typeof error?.message === "string" && /^[a-z][a-z0-9_]{1,120}$/u.test(error.message)
    ? error.message
    : "target_entry_failed";
}
