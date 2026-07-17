export function createE2EVerdict({ apiKeyChecks, fullRoadmapChecks }) {
  const apiKeyPassed = apiKeyChecks.length > 0 && apiKeyChecks.every(({ status }) => status === "passed");
  const missingFullCheck = fullRoadmapChecks.find(({ status }) => status !== "passed");
  return {
    automated_api_key_v1_e2e: {
      status: apiKeyPassed ? "passed" : "incomplete",
      checks: apiKeyChecks,
    },
    roadmap_v1: {
      status: missingFullCheck ? "incomplete" : "passed",
      checks: fullRoadmapChecks,
      ...(missingFullCheck ? { reason: reasonFor(missingFullCheck) } : {}),
    },
  };
}

function reasonFor(check) {
  return check.reason ?? String(check.id).replaceAll("-", "_") + "_not_run";
}
