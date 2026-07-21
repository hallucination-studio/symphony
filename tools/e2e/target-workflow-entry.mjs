import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { TARGET_WORKFLOW_SCENARIOS } from "./target-workflow-verdict.mjs";
import { auditTargetWorkflowSources } from "./target-workflow-static-audit.mjs";

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
    process.stderr.write('{"status":"failed","reason":"target_entry_argument_invalid"}\n');
    process.exitCode = 2;
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

function stableReason(error) {
  return typeof error?.message === "string" && /^[a-z][a-z0-9_]{1,120}$/u.test(error.message)
    ? error.message
    : "target_entry_failed";
}
