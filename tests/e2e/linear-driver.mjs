function clone(value) {
  return structuredClone(value);
}

function frozen(value) {
  return Object.freeze(value);
}

function requireText(value, code) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 100_000 || value.includes("\0")) {
    throw new Error(code);
  }
  return value;
}

function uploadContents(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  throw new Error("linear_upload_contents_invalid");
}

function requireStatus(value) {
  if (!["todo", "active", "completed", "canceled"].includes(value)) throw new Error("linear_status_invalid");
  return value;
}

function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

export function formatLocalTimestamp(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absoluteOffset = Math.abs(offsetMinutes);
  return [
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`,
    `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`,
  ].join("");
}

const ROOT_DESCRIPTION_START = "# Symphony Harness: Managed Root";
const ROOT_DESCRIPTION_END = "# Symphony Harness: End Managed Root";

function rootRequirement(description) {
  const marker = `\n\n${ROOT_DESCRIPTION_START}\n`;
  const index = description.indexOf(marker);
  return index < 0 ? description : description.slice(0, index);
}

function rootStateDescription(description, state) {
  return [
    rootRequirement(description),
    ROOT_DESCRIPTION_START,
    "## Metadata",
    `Updated at: ${formatLocalTimestamp()}`,
    "### Root State",
    "",
    "```json",
    JSON.stringify(state, null, 2),
    "```",
    ROOT_DESCRIPTION_END,
  ].join("\n\n");
}

function managedDescription(task, metadata) {
  return ["# Task", task, "# Symphony Metadata", metadata].join("\n\n");
}

export class LinearDriver {
  #root;
  #comments = [];
  #state;
  #cycles = [];
  #uploads = [];
  #uploadFailures = [];
  #commentNumber = 0;
  #cycleNumber = 0;
  #events = [];

  constructor({ root = {}, rootState, uploadFailures = [] } = {}) {
    this.#root = {
      id: root.id ?? "root-1",
      identifier: root.identifier ?? "ENG-1",
      title: root.title ?? "Root scenario",
      description: root.description ?? "A deterministic Root scenario.",
      status: requireStatus(root.status ?? "todo"),
      parent_id: null,
      team_id: root.team_id ?? "team-1",
    };
    this.#state = rootState === undefined ? undefined : clone(rootState);
    this.#uploadFailures = [...uploadFailures];
  }

  async readRoot() {
    return frozen(clone(this.#root));
  }

  async setRootStatus(status) {
    this.#root.status = requireStatus(status);
    this.#events.push(frozen({ event: "root_status", status }));
  }

  async listRootCommentsAfter(cursor) {
    const rootComments = this.#comments.filter((comment) => comment.issue_id === this.#root.id);
    if (cursor === undefined || cursor === null) return frozen(rootComments.map(clone));
    const index = rootComments.findIndex((comment) => comment.id === cursor);
    if (index < 0) throw new Error("linear_comment_cursor_not_found");
    return frozen(rootComments.slice(index + 1).map(clone));
  }

  async addRootComment(body, { creatorId = "user-1" } = {}) {
    const comment = {
      id: `comment-${++this.#commentNumber}`,
      issue_id: this.#root.id,
      body: requireText(body, "linear_comment_invalid"),
      creator_id: requireText(creatorId, "linear_creator_invalid"),
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, this.#commentNumber)).toISOString(),
    };
    this.#comments.push(comment);
    this.#events.push(frozen({ event: "root_comment", comment_id: comment.id }));
    return frozen(clone(comment));
  }

  async createComment(issueId, body) {
    const comment = {
      id: `comment-${++this.#commentNumber}`,
      issue_id: requireText(issueId, "linear_comment_issue_invalid"),
      body: requireText(body, "linear_comment_invalid"),
      creator_id: "harness-1",
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, this.#commentNumber)).toISOString(),
    };
    this.#comments.push(comment);
    this.#events.push(frozen({ event: "comment_created", comment_id: comment.id, issue_id: issueId }));
    return frozen(clone(comment));
  }

  async updateIssueDescription(issueId, description) {
    const value = requireText(description, "linear_issue_description_invalid");
    if (issueId === this.#root.id) {
      this.#root.description = value;
    } else {
      const cycle = this.#cycles.find((entry) => (
        entry.execute_issue?.id === issueId || entry.audit_issue?.id === issueId
      ));
      if (cycle === undefined) throw new Error("linear_issue_not_found");
      if (cycle.execute_issue.id === issueId) cycle.execute_issue.description = value;
      else cycle.audit_issue.description = value;
    }
    this.#events.push(frozen({ event: "issue_description", issue_id: issueId }));
  }

  async uploadFile(filename, contentType, contents) {
    const failure = this.#uploadFailures.shift();
    if (failure !== undefined) throw new Error(String(failure).slice(0, 50));
    if (contentType !== "application/json") throw new Error("linear_upload_type_invalid");
    const upload = {
      id: `upload-${this.#uploads.length + 1}`,
      filename: requireText(filename, "linear_upload_filename_invalid"),
      content_type: contentType,
      contents: uploadContents(contents),
      url: `https://linear.example/upload/${this.#uploads.length + 1}`,
    };
    this.#uploads.push(upload);
    this.#events.push(frozen({ event: "file_uploaded", upload_id: upload.id, filename }));
    return frozen(clone({ url: upload.url }));
  }

  async listComments(issueId) {
    return frozen(this.#comments.filter((comment) => comment.issue_id === issueId).map(clone));
  }

  async listUploads() {
    return frozen(this.#uploads.map(clone));
  }

  async readRootState() {
    return this.#state === undefined ? undefined : frozen(clone(this.#state));
  }

  async writeRootState(state) {
    if (state === null || typeof state !== "object" || Array.isArray(state)) throw new Error("linear_state_invalid");
    this.#state = clone(state);
    this.#root.description = rootStateDescription(this.#root.description, state);
    this.#events.push(frozen({ event: "root_state", phase: state.current_phase }));
    return frozen(clone(this.#state));
  }

  async createCycle({ objective, acceptance, boundaries, consumedCommentIds = [] }) {
    const cycle = {
      id: `cycle-${++this.#cycleNumber}`,
      objective: requireText(objective, "cycle_objective_invalid"),
      acceptance: requireText(acceptance, "cycle_acceptance_invalid"),
      boundaries: requireText(boundaries, "cycle_boundaries_invalid"),
      consumed_comment_ids: [...consumedCommentIds],
      status: "active",
      execute: null,
      audit: null,
      execute_issue: {
        id: `execute-${this.#cycleNumber}`,
        title: `[Executor] Cycle ${String(this.#cycleNumber).padStart(3, "0")}`,
        description: managedDescription(
          ["## Objective", objective, "## Acceptance", acceptance, "## Boundaries", boundaries].join("\n\n"),
          "## Role\n\nExecute\n\n## Access\n\nworkspace-write",
        ),
      },
      audit_issue: {
        id: `audit-${this.#cycleNumber}`,
        title: `[Audit] Cycle ${String(this.#cycleNumber).padStart(3, "0")}`,
        description: managedDescription(
          ["## Acceptance", acceptance, "## Boundaries", boundaries].join("\n\n"),
          "## Role\n\nAudit\n\n## Access\n\nread-only",
        ),
      },
      result: null,
    };
    this.#cycles.push(cycle);
    this.#events.push(frozen({ event: "cycle_created", cycle_id: cycle.id }));
    return frozen(clone(cycle));
  }

  #cycle(id) {
    const cycle = this.#cycles.find((entry) => entry.id === id);
    if (cycle === undefined) throw new Error("cycle_not_found");
    return cycle;
  }

  async recordExecute(cycleId, facts) {
    const cycle = this.#cycle(cycleId);
    if (cycle.execute !== null) throw new Error("execute_already_recorded");
    cycle.execute = clone(facts);
    this.#events.push(frozen({ event: "execute_recorded", cycle_id: cycleId }));
  }

  async recordAudit(cycleId, result) {
    const cycle = this.#cycle(cycleId);
    if (cycle.audit !== null) throw new Error("audit_already_recorded");
    cycle.audit = clone(result);
    this.#events.push(frozen({ event: "audit_recorded", cycle_id: cycleId, verdict: result.verdict }));
  }

  async finishCycle(cycleId, result, uploadOutcome = undefined) {
    const cycle = this.#cycle(cycleId);
    if (cycle.execute === null || cycle.audit === null) throw new Error("cycle_incomplete");
    if (!["succeeded", "rejected", "failed"].includes(result)) throw new Error("cycle_result_invalid");
    cycle.status = "completed";
    cycle.result = result;
    if (uploadOutcome === undefined) delete cycle.upload_outcome;
    else cycle.upload_outcome = clone(uploadOutcome);
    this.#events.push(frozen({ event: "cycle_finished", cycle_id: cycleId, result }));
  }

  async snapshot() {
    return frozen({
      root: clone(this.#root),
      root_state: this.#state === undefined ? undefined : clone(this.#state),
      root_comments: this.#comments.filter((comment) => comment.issue_id === this.#root.id).map(clone),
      cycles: this.#cycles.map(clone),
      comments: this.#comments.map(clone),
      uploads: this.#uploads.map(clone),
      events: this.#events.map(clone),
    });
  }
}
