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
  if (!["todo", "in_progress", "in_review", "needs_human", "done", "canceled"].includes(value)) {
    throw new Error("linear_status_invalid");
  }
  return value;
}

const LINEAR_REACTION_EMOJIS = ["white_check_mark", "x"];
const ROOT_NEEDS_HUMAN_COMMENT_MARKER = "# Symphony Harness: Human Action";

function requireReactionEmoji(value) {
  if (!LINEAR_REACTION_EMOJIS.includes(value)) throw new Error("linear_comment_reaction_emoji_invalid");
  return value;
}

function requireHumanQuestions(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("linear_human_questions_invalid");
  return value.map((question) => {
    if (question === null || typeof question !== "object" || Array.isArray(question)) {
      throw new Error("linear_human_question_invalid");
    }
    const options = question.options;
    if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
      throw new Error("linear_human_options_invalid");
    }
    return {
      question: requireText(question.question, "linear_human_question_invalid"),
      options: options.map((option) => {
        if (option === null || typeof option !== "object" || Array.isArray(option)) {
          throw new Error("linear_human_option_invalid");
        }
        return {
          key: requireText(option.key, "linear_human_option_invalid"),
          label: requireText(option.label, "linear_human_option_invalid"),
          consequence: requireText(option.consequence, "linear_human_option_invalid"),
        };
      }),
    };
  });
}

function needsHumanComment({ reason, questions }) {
  const sections = questions.flatMap((question, index) => [
    `### ${index + 1}. ${question.question}`,
    "",
    ...question.options.map((option) => (
      `- **${option.key}. ${option.label}**: ${option.consequence}`
    )),
    "",
  ]);
  return [
    ROOT_NEEDS_HUMAN_COMMENT_MARKER,
    "",
    "## Reason",
    "",
    reason,
    "",
    "## Questions",
    "",
    ...sections,
  ].join("\n").trimEnd();
}

function isHarnessComment(body) {
  return body.startsWith("# Symphony Harness:");
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
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    ` GMT${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`,
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
  const decisions = Array.isArray(state.architecture_decisions)
    ? state.architecture_decisions
    : [];
  const decisionLines = decisions.length === 0
    ? ["## Architecture Decisions", "", "None recorded."]
    : [
      "## Architecture Decisions",
      "",
      ...decisions.flatMap((decision) => [
        `## ${decision.id}`,
        "",
        `- id: ${decision.id}`,
        `- title: ${decision.title}`,
        `- decision: ${decision.decision}`,
        `- rationale: ${decision.rationale}`,
        "- consequences:",
        ...decision.consequences.map((consequence) => `  - ${consequence}`),
        `- source_action_comment_id: ${decision.source_action_comment_id}`,
        `- source_reply_ids: [${decision.source_reply_ids.join(", ")}]`,
        `- decided_at: ${decision.decided_at}`,
        "",
      ]),
    ];
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
    ...decisionLines,
    ROOT_DESCRIPTION_END,
  ].join("\n\n");
}

function managedDescription(task, metadata) {
  return ["# Task", task, "# Symphony Metadata", metadata].join("\n\n");
}

export class LinearDriver {
  #root;
  #comments = [];
  #reactions = [];
  #state;
  #cycles = [];
  #uploads = [];
  #uploadFailures = [];
  #commentNumber = 0;
  #reactionNumber = 0;
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
    await this.updateIssueStatus(this.#root.id, status);
  }

  async updateIssueStatus(issueId, status) {
    const nextStatus = requireStatus(status);
    let issue;
    if (issueId === this.#root.id) {
      issue = this.#root;
    } else {
      for (const cycle of this.#cycles) {
        if (cycle.id === issueId) issue = cycle;
        else if (cycle.artist_issue.id === issueId) issue = cycle.artist_issue;
        else if (cycle.critic_issue.id === issueId) issue = cycle.critic_issue;
        if (issue !== undefined) break;
      }
    }
    if (issue === undefined) throw new Error("linear_issue_not_found");
    const previousStatus = issue.status;
    if (previousStatus === nextStatus) return;
    issue.status = nextStatus;
    this.#events.push(frozen({
      event: "status_transition",
      issue_id: issueId,
      from: previousStatus,
      to: nextStatus,
    }));
  }

  async listRootCommentsAfter(cursor) {
    const rootComments = this.#comments.filter((comment) => (
      comment.issue_id === this.#root.id && comment.parent_id === null
    ));
    if (cursor === undefined || cursor === null) return frozen(rootComments.map(clone));
    const index = rootComments.findIndex((comment) => comment.id === cursor);
    if (index < 0) throw new Error("linear_comment_cursor_not_found");
    return frozen(rootComments.slice(index + 1).map(clone));
  }

  async listRootUserCommentsAfter(cursor) {
    const comments = await this.listRootCommentsAfter(cursor);
    return frozen(comments.filter((comment) => !isHarnessComment(comment.body)).map(clone));
  }

  async listThreadRepliesAfter(parentId, cursor) {
    const replies = this.#comments.filter((comment) => (
      comment.issue_id === this.#root.id && comment.parent_id === parentId
    ));
    if (cursor === undefined || cursor === null) return frozen(replies.map(clone));
    const index = replies.findIndex((comment) => comment.id === cursor);
    if (index < 0) throw new Error("linear_comment_cursor_not_found");
    return frozen(replies.slice(index + 1).map(clone));
  }

  async addRootComment(body, { creatorId = "user-1", parentId = null } = {}) {
    const comment = {
      id: `comment-${++this.#commentNumber}`,
      issue_id: this.#root.id,
      parent_id: parentId,
      body: requireText(body, "linear_comment_invalid"),
      creator_id: requireText(creatorId, "linear_creator_invalid"),
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, this.#commentNumber)).toISOString(),
    };
    this.#comments.push(comment);
    this.#events.push(frozen({
      event: "root_comment",
      comment_id: comment.id,
      parent_id: parentId,
    }));
    return frozen(clone(comment));
  }

  async createComment(issueId, body, { parentId = null, creatorId = "harness-1" } = {}) {
    const comment = {
      id: `comment-${++this.#commentNumber}`,
      issue_id: requireText(issueId, "linear_comment_issue_invalid"),
      parent_id: parentId,
      body: requireText(body, "linear_comment_invalid"),
      creator_id: requireText(creatorId, "linear_creator_invalid"),
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, this.#commentNumber)).toISOString(),
    };
    this.#comments.push(comment);
    this.#events.push(frozen({
      event: "comment_created",
      comment_id: comment.id,
      issue_id: issueId,
      parent_id: parentId,
    }));
    return frozen(clone(comment));
  }

  async createCommentReaction(commentId, emoji) {
    if (!this.#comments.some((comment) => comment.id === commentId)) {
      throw new Error("linear_comment_not_found");
    }
    const reaction = {
      id: `reaction-${++this.#reactionNumber}`,
      comment_id: commentId,
      emoji: requireReactionEmoji(emoji),
    };
    this.#reactions.push(reaction);
    this.#events.push(frozen({
      event: "comment_reaction",
      comment_id: commentId,
      emoji,
    }));
    return frozen(clone(reaction));
  }

  get reactions() {
    return frozen(this.#reactions.map(clone));
  }

  async pauseForHuman({ reason, questions } = {}) {
    const humanReason = requireText(reason, "linear_human_reason_invalid");
    const humanQuestions = requireHumanQuestions(questions);
    const questionComment = await this.createComment(
      this.#root.id,
      needsHumanComment({ reason: humanReason, questions: humanQuestions }),
    );
    await this.writeRootState({
      ...(this.#state === undefined ? {} : clone(this.#state)),
      current_phase: "NeedsHuman",
      harness_feedback: humanReason,
      comment_cursor: questionComment.id,
      human_action: {
        action_id: `human-action-${questionComment.id}`,
        root_issue_id: this.#root.id,
        request_comment_id: questionComment.id,
        questions: humanQuestions,
        reply_comment_ids: [],
        status: "pending",
        thread_cursor: undefined,
      },
      architecture_decisions: this.#state?.architecture_decisions ?? [],
    });
    await this.setRootStatus("needs_human");
    return frozen(clone(questionComment));
  }

  async processHumanReply({
    cursor,
    requestCommentId = cursor,
    disposition,
    nextStatus = "in_review",
    rejection,
    acceptedDecision = {
      title: "Choose the caller-owned boundary",
      decision: "Use the caller-owned boundary.",
      rationale: "The accepted reply gives the caller control of transaction boundaries.",
      consequences: [
        "Callers control transaction boundaries.",
        "The service remains composable within existing transactions.",
      ],
    },
  } = {}) {
    if (disposition !== "accepted" && disposition !== "rejected") {
      throw new Error("linear_reply_disposition_invalid");
    }
    const replies = (await this.listThreadRepliesAfter(
      requestCommentId,
      cursor === requestCommentId ? undefined : cursor,
    )).filter((comment) => !isHarnessComment(comment.body));
    if (replies.length === 0) {
      await this.setRootStatus("needs_human");
      return frozen({ status: "needs_human", disposition: "unanswered", comments: [] });
    }
    const emoji = disposition === "accepted" ? "white_check_mark" : "x";
    for (const comment of replies) await this.createCommentReaction(comment.id, emoji);
    if (disposition === "rejected") {
      if (rejection === undefined) throw new Error("linear_rejection_question_missing");
      const questionComment = await this.createComment(
        this.#root.id,
        needsHumanComment(rejection),
        { parentId: requestCommentId },
      );
      await this.writeRootState({
        ...(this.#state === undefined ? {} : clone(this.#state)),
        current_phase: "NeedsHuman",
        harness_feedback: rejection.reason,
        comment_cursor: questionComment.id,
        human_action: {
          ...(this.#state?.human_action ?? {}),
          reply_comment_ids: [
            ...(this.#state?.human_action?.reply_comment_ids ?? []),
            ...replies.map(({ id }) => id),
          ],
          status: "pending",
          thread_cursor: replies.at(-1).id,
        },
        architecture_decisions: this.#state?.architecture_decisions ?? [],
      });
      return frozen(clone({
        status: "needs_human",
        disposition,
        comments: replies,
        question: questionComment,
      }));
    }
    const status = requireStatus(nextStatus);
    const priorDecisions = this.#state?.architecture_decisions ?? [];
    const decision = {
      id: `ADR-${String(priorDecisions.length + 1).padStart(3, "0")}`,
      title: requireText(acceptedDecision.title, "linear_decision_title_invalid"),
      decision: requireText(acceptedDecision.decision, "linear_decision_value_invalid"),
      rationale: requireText(acceptedDecision.rationale, "linear_decision_rationale_invalid"),
      consequences: acceptedDecision.consequences.map((consequence) => (
        requireText(consequence, "linear_decision_consequence_invalid")
      )),
      source_action_comment_id: requestCommentId,
      source_reply_ids: replies.map(({ id }) => id),
      decided_at: formatLocalTimestamp(),
    };
    const architectureDecisions = [...priorDecisions, decision];
    await this.writeRootState({
      ...(this.#state === undefined ? {} : clone(this.#state)),
      current_phase: status === "needs_human" ? "NeedsHuman" : "idle",
      comment_cursor: replies.at(-1).id,
      human_action: undefined,
      architecture_decisions: architectureDecisions,
    });
    await this.setRootStatus(status);
    return frozen(clone({ status, disposition, comments: replies, decision }));
  }

  async updateIssueDescription(issueId, description) {
    const value = requireText(description, "linear_issue_description_invalid");
    if (issueId === this.#root.id) {
      this.#root.description = value;
    } else {
      const cycle = this.#cycles.find((entry) => (
        entry.artist_issue?.id === issueId || entry.critic_issue?.id === issueId
      ));
      if (cycle === undefined) throw new Error("linear_issue_not_found");
      if (cycle.artist_issue.id === issueId) cycle.artist_issue.description = value;
      else cycle.critic_issue.description = value;
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

  async createCycle({
    objective,
    acceptance,
    boundaries,
    consumedCommentIds = [],
    architectureDecisions = this.#state?.architecture_decisions ?? [],
  }) {
    const cycle = {
      id: `cycle-${++this.#cycleNumber}`,
      objective: requireText(objective, "cycle_objective_invalid"),
      acceptance: requireText(acceptance, "cycle_acceptance_invalid"),
      boundaries: requireText(boundaries, "cycle_boundaries_invalid"),
      consumed_comment_ids: [...consumedCommentIds],
      architecture_decisions: clone(architectureDecisions),
      description: managedDescription(
        ["## Objective", objective, "## Acceptance", acceptance, "## Boundaries", boundaries].join("\n\n"),
        "## Role\n\nCycle",
      ),
      status: "todo",
      artist: null,
      critic: null,
      artist_issue: {
        id: `execute-${this.#cycleNumber}`,
        identifier: `ENG-${this.#cycleNumber * 3 - 1}`,
        url: `https://linear.example/issue/ENG-${this.#cycleNumber * 3 - 1}`,
        title: `[Artist] Cycle ${String(this.#cycleNumber).padStart(3, "0")}`,
        status: "todo",
        description: managedDescription(
          ["## Objective", objective, "## Acceptance", acceptance, "## Boundaries", boundaries].join("\n\n"),
          "## Role\n\nArtist\n\n## Access\n\nworkspace-write",
        ),
      },
      critic_issue: {
        id: `audit-${this.#cycleNumber}`,
        identifier: `ENG-${this.#cycleNumber * 3}`,
        url: `https://linear.example/issue/ENG-${this.#cycleNumber * 3}`,
        title: `[Critic] Cycle ${String(this.#cycleNumber).padStart(3, "0")}`,
        status: "todo",
        description: managedDescription(
          ["## Acceptance", acceptance, "## Boundaries", boundaries].join("\n\n"),
          "## Role\n\nCritic\n\n## Access\n\nread-only",
        ),
      },
      result: null,
    };
    const decisionSnapshot = architectureDecisions.length === 0
      ? "## Architecture Decisions\n\nNone recorded."
      : [
        "## Architecture Decisions",
        "",
        ...architectureDecisions.flatMap((decision) => [
          `## ${decision.id}`,
          "",
          `- id: ${decision.id}`,
          `- title: ${decision.title}`,
          `- decision: ${decision.decision}`,
          `- rationale: ${decision.rationale}`,
          "- consequences:",
          ...decision.consequences.map((consequence) => `  - ${consequence}`),
          `- source_action_comment_id: ${decision.source_action_comment_id}`,
          `- source_reply_ids: [${decision.source_reply_ids.join(", ")}]`,
          `- decided_at: ${decision.decided_at}`,
          "",
        ]),
      ].join("\n");
    cycle.description = cycle.description.replace("# Symphony Metadata", `${decisionSnapshot}\n\n# Symphony Metadata`);
    this.#cycles.push(cycle);
    this.#events.push(frozen({
      event: "cycle_created",
      cycle_id: cycle.id,
      cycle_status: cycle.status,
      artist_status: cycle.artist_issue.status,
      critic_status: cycle.critic_issue.status,
    }));
    return frozen(clone(cycle));
  }

  #cycle(id) {
    const cycle = this.#cycles.find((entry) => entry.id === id);
    if (cycle === undefined) throw new Error("cycle_not_found");
    return cycle;
  }

  async recordArtist(cycleId, facts) {
    const cycle = this.#cycle(cycleId);
    if (cycle.artist !== null) throw new Error("artist_already_recorded");
    cycle.artist = clone(facts);
    this.#events.push(frozen({ event: "artist_recorded", cycle_id: cycleId }));
  }

  async recordCritic(cycleId, result) {
    const cycle = this.#cycle(cycleId);
    if (cycle.critic !== null) throw new Error("critic_already_recorded");
    cycle.critic = clone(result);
    this.#events.push(frozen({ event: "critic_recorded", cycle_id: cycleId, verdict: result.verdict }));
  }

  async finishCycle(cycleId, result, uploadOutcome = undefined) {
    const cycle = this.#cycle(cycleId);
    if (cycle.artist === null || cycle.critic === null) throw new Error("cycle_incomplete");
    if (!["succeeded", "rejected", "failed"].includes(result)) throw new Error("cycle_result_invalid");
    cycle.result = result;
    if (uploadOutcome === undefined) delete cycle.upload_outcome;
    else cycle.upload_outcome = clone(uploadOutcome);
    await this.updateIssueStatus(cycle.id, "done");
    this.#events.push(frozen({ event: "cycle_finished", cycle_id: cycleId, result }));
  }

  async snapshot() {
    return frozen({
      root: clone(this.#root),
      root_state: this.#state === undefined ? undefined : clone(this.#state),
      root_comments: this.#comments.filter((comment) => comment.issue_id === this.#root.id).map(clone),
      cycles: this.#cycles.map(clone),
      comments: this.#comments.map(clone),
      reactions: this.#reactions.map(clone),
      uploads: this.#uploads.map(clone),
      events: this.#events.map(clone),
    });
  }
}

const DEFAULT_HUMAN_QUESTIONS = Object.freeze([{
  question: "Which boundary should Symphony use?",
  options: [
    { key: "A", label: "Service-owned", consequence: "The service owns the transaction." },
    { key: "B", label: "Caller-owned", consequence: "The caller owns the transaction." },
  ],
}]);

export async function runHumanActionScenario({
  linear,
  mode,
  reason = "Choose one API boundary.",
  questions = DEFAULT_HUMAN_QUESTIONS,
  replyBodies = [],
  rejection = {
    reason: "The reply does not choose one boundary.",
    questions: DEFAULT_HUMAN_QUESTIONS,
  },
  supplementBody = "Use the caller-owned boundary.",
} = {}) {
  if (!(linear instanceof LinearDriver)) throw new Error("linear_driver_required");
  if (!["unanswered", "accepted", "rejected_then_supplement"].includes(mode)) {
    throw new Error("linear_human_scenario_invalid");
  }
  const question = await linear.pauseForHuman({ reason, questions });
  if (mode === "unanswered") {
    const reply = await linear.processHumanReply({
      requestCommentId: question.id,
      cursor: question.id,
      disposition: "accepted",
    });
    return frozen({ mode, question, reply, state: await linear.snapshot() });
  }

  const bodies = replyBodies.length > 0
    ? replyBodies
    : mode === "accepted"
      ? ["Use the caller-owned boundary."]
      : ["Maybe use either boundary.", "I am not sure yet."];
  const replies = [];
  for (const body of bodies) {
    replies.push(await linear.addRootComment(body, { parentId: question.id }));
  }
  const firstReply = await linear.processHumanReply({
    requestCommentId: question.id,
    cursor: question.id,
    disposition: mode === "accepted" ? "accepted" : "rejected",
    nextStatus: "in_review",
    rejection,
    acceptedDecision: {
      title: "Choose the caller-owned boundary",
      decision: "Use the caller-owned boundary.",
      rationale: "The accepted reply gives the caller control of transaction boundaries.",
      consequences: [
        "Callers control transaction boundaries.",
        "The service remains composable within existing transactions.",
      ],
    },
  });
  let finalReply = firstReply;
  if (mode === "rejected_then_supplement") {
    const followUpQuestion = firstReply.question;
    if (followUpQuestion === undefined) throw new Error("linear_follow_up_question_missing");
    const supplement = await linear.addRootComment(supplementBody, { parentId: question.id });
    finalReply = await linear.processHumanReply({
      requestCommentId: question.id,
      cursor: replies.at(-1).id,
      disposition: "accepted",
      nextStatus: "in_review",
      acceptedDecision: {
        title: "Choose the caller-owned boundary",
        decision: "Use the caller-owned boundary.",
        rationale: "The accepted reply gives the caller control of transaction boundaries.",
        consequences: [
          "Callers control transaction boundaries.",
          "The service remains composable within existing transactions.",
        ],
      },
    });
    finalReply = frozen(clone({ ...finalReply, supplement }));
  }
  return frozen({ mode, question, firstReply, finalReply, state: await linear.snapshot() });
}
