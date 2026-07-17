export function createRoadmapV1Verdict(automatedApiKeyVerdict) {
  return Object.freeze({
    automated_api_key_v1_e2e: automatedApiKeyVerdict,
    roadmap_v1: Object.freeze({
      status: "incomplete",
      reason: "chatgpt_live_login_not_run",
    }),
  });
}
