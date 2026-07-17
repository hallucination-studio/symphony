const ROADMAP_ACCEPTANCE = "docs/architecture/roadmap.md#8-v1验收边界";

const rows = [
  ["A01", "Linear Token只在Podium，Conductor通过Gateway完成Linear读写", "T3/T4/T7", "live", "linear_gateway_ownership"],
  ["A02", "Conductor Project Label唯一解析到Resolved Conductor Project，Label变化后下个Turn边界切换Project", "T3/T4/T7", "live", "project_label_turn_boundary"],
  ["A03", "一个Root只产生一个Root Managed Comment、Root Phase Label、branch和worktree", "T4/T7", "live", "root_singletons"],
  ["A04", "Plan生成的嵌套Tree与Linear parent/order一致", "T4/T5/T7", "live", "plan_tree_parent_order"],
  ["A05", "未批准Plan不会执行Work", "T4/T5/T7", "live", "plan_approval_gate"],
  ["A06", "用户新增或重排Sub Issue后，下一个Turn使用最新Tree", "T4/T5/T7", "live", "next_turn_tree_refresh"],
  ["A07", "Root title/description变化后重新Plan、reconcile未完成Work并重新批准", "T4/T5/T7", "live", "root_change_replan"],
  ["A08", "Work Leaf title/description变化后只重跑该Work，不重做整棵Plan", "T4/T5/T7", "live", "work_change_local_rerun"],
  ["A09", "Performer中断后能以同一performer_id继续In Progress Work", "T4/T5/T7", "live", "performer_resume_identity"],
  ["A10", "Root Gate失败创建一个Rework Work，成功才进入交付", "T3/T4/T5/T7", "live", "gate_rework_before_delivery"],
  ["A11", "gh可用时创建或复用PR，不可用时清楚交付branch", "T3/T4/T5/T7", "live", "github_or_branch_delivery"],
  ["A12", "Root只进入In Review，不由Symphony自动Done", "T3/T4/T5/T7", "live", "root_stops_in_review"],
  ["A13", "Canceled Work和subtree不参与Root Gate", "T3/T4/T5/T7", "live", "canceled_subtree_excluded"],
  ["A14", "In Review/Done Work缺少合法metadata时不会被静默视为完成", "T3/T4/T5/T7", "live", "invalid_metadata_blocks"],
  ["A15", "用户在Turn期间Done/Canceled Root后，旧Result不能推进", "T3/T4/T5/T7", "live", "stale_result_rejected"],
  ["A16", "Linear mutation precondition冲突后重新读取，不覆盖用户最新state", "T3/T4/T5/T7", "live", "linear_conflict_reread"],
  ["A17", "Work commit/hash/state任一步中断后可以从Linear和Git收敛", "T3/T4/T5/T7", "live", "commit_hash_state_convergence"],
  ["A18", "Conductor重启不依赖数据库", "T2/T4/T6/T7", "packaged", "database_free_restart"],
  ["A19", "Desktop可以创建多个Profile，ChatGPT/API Key登录只调用Codex SDK", "T3/T4/T5/T6/T7", "packaged", "desktop_sdk_profile_login"],
  ["A20", "Symphony不读取或改写auth.json、config.toml", "T3/T4/T5/T6/T7", "packaged", "codex_owned_files_untouched"],
  ["A21", "activate Profile无需重启，新Root使用新Profile，已有Root保持原Profile", "T3/T4/T5/T6/T7", "packaged", "profile_activation_scope"],
  ["A22", "model、reasoning和Fast在下一个Turn通过SDK参数生效", "T3/T4/T5/T6/T7", "live", "next_turn_sdk_settings"],
  ["A23", "API Key不进入Podium/Conductor自定义持久化或任何View/日志", "T3/T4/T5/T6/T7", "packaged", "api_key_non_persistence"],
  ["A24", "Desktop显示best-effort Token usage和Completed Roots。", "T3/T4/T5/T6/T7", "packaged", "desktop_usage_and_completed_roots"],
];

export const V1_ACCEPTANCE_REGISTRY = Object.freeze(
  rows.map(([id, fact, owner, boundary, requiredCheck]) =>
    Object.freeze({
      id,
      fact,
      citation: ROADMAP_ACCEPTANCE,
      owner,
      boundary,
      command: "npm run acceptance:collect",
      artifactPath: `artifacts/${id}.json`,
      requiredCheck,
      requiredTools: Object.freeze(requiredTools(id, boundary)),
    }),
  ),
);

export function validateV1Registry(registry = V1_ACCEPTANCE_REGISTRY) {
  const expectedIds = Array.from({ length: 24 }, (_, index) =>
    `A${String(index + 1).padStart(2, "0")}`,
  );
  if (!Array.isArray(registry) || registry.length !== expectedIds.length) return false;

  return registry.every((row, index) => {
    const keys = Object.keys(row).sort();
    return keys.join(",") === "artifactPath,boundary,citation,command,fact,id,owner,requiredCheck,requiredTools"
      && row.id === expectedIds[index]
      && typeof row.fact === "string" && row.fact.length > 0
      && /^docs\/architecture\/.+\.md#/.test(row.citation)
      && row.owner === expectedOwner(row.id)
      && row.command === "npm run acceptance:collect"
      && ["live", "packaged", "static"].includes(row.boundary)
      && row.artifactPath === `artifacts/${row.id}.json`
      && /^[a-z0-9_]+$/.test(row.requiredCheck)
      && row.requiredTools.join(",") === requiredTools(row.id, row.boundary).join(",");
  });
}

function requiredTools(id, boundary) {
  const tools = ["git", "node", "npm"];
  if (boundary === "packaged") tools.push("python", "rustc", "tauri");
  if (["A04", "A05", "A06", "A07", "A08", "A09", "A10", "A13", "A15", "A17", "A22"].includes(id)) {
    tools.push("python");
  }
  if (id === "A11") tools.push("gh");
  return [...new Set(tools)].sort();
}

function expectedOwner(id) {
  const number = Number(id.slice(1));
  if (number <= 2) return "T3/T4/T7";
  if (number === 3) return "T4/T7";
  if (number <= 9) return "T4/T5/T7";
  if (number <= 17) return "T3/T4/T5/T7";
  if (number === 18) return "T2/T4/T6/T7";
  return "T3/T4/T5/T6/T7";
}
