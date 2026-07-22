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
  if (scenario === "repair") return runTargetRepairLive({ config });
  if (scenario === "delivery") return runTargetDeliveryLive({ config });
  if (scenario === "restart_recovery") return runTargetRestartLive({ config });
  if (scenario === "scheduling") return runTargetSchedulingLive({ config });
  if (scenario === "all") return runTargetWorkflowAllLive({ config });
  return runTargetSuccessLive({ config });
}

export async function runTargetWorkflowAllLive({
  config,
  environment = process.env,
  fetch = globalThis.fetch,
  log = () => {},
  runScenario = defaultRunScenario,
  prepareSetup = prepareTargetWorkflowSetup,
  writeEvidence = true,
  evidenceDirectory,
} = {}) {
  if (!config?.linear?.projectSlugId) throw stableError("target_all_configuration_invalid");
  if (!environment || typeof environment !== "object" || typeof runScenario !== "function" ||
      typeof prepareSetup !== "function" || typeof fetch !== "function" || typeof log !== "function") {
    throw stableError("target_all_input_invalid");
  }
  const preparedSetup = await prepareSetup({
    config,
    runId: environment.SYMPHONY_E2E_RUN_ID,
    fetch,
    log,
  });
  const results = [];
  for (const scenario of TARGET_WORKFLOW_SCENARIOS) {
    try {
      const result = await runScenario(scenario, {
        config,
        environment,
        fetch,
        log,
        setup: preparedSetup,
      });
      if (!result || typeof result !== "object" || result.scenario !== scenario) {
        throw stableError("target_all_scenario_result_invalid");
      }
      results.push(result);
    } catch (error) {
      results.push(Object.freeze({
        scenario,
        status: "failed",
        reason: stableReason(error),
      }));
    }
  }
  const evaluated = evaluateTargetWorkflowResults({ results, cleanupCompleted: true, setup: preparedSetup }, {
    secrets: [config.secrets?.linearDevToken, config.secrets?.codexApiKey],
  });
  const result = Object.freeze({
    status: evaluated.verdict.verdict,
    runId: environment.SYMPHONY_E2E_RUN_ID,
    evidence: evaluated.evidence,
    verdict: evaluated.verdict,
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

async function defaultRunScenario(scenario, { setup, ...input }) {
  const dependencies = { prepareSetup: async () => setup };
  if (scenario === "success") return runTargetSuccessLive({ ...input, dependencies });
  if (scenario === "repair_escalation") return runTargetRepairLive({ ...input, dependencies });
  if (scenario === "restart_recovery") return runTargetRestartLive({ ...input, dependencies });
  if (scenario === "delivery") return runTargetDeliveryLive({ ...input, dependencies });
  return runTargetSchedulingLive({ ...input, dependencies });
}

function stableReason(error) {
  return typeof error?.message === "string" && /^[a-z][a-z0-9_]{1,120}$/u.test(error.message)
    ? error.message
    : "target_entry_failed";
}
