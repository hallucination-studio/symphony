import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const ENDPOINT = "https://api.linear.app/graphql";

// Diagnostics are intentionally bounded. The archive is private, so raw
// output is retained there while the runner result only exposes its path.
export const MAX_DIAGNOSTIC_STREAM_BYTES = 256 * 1024;
export const MAX_DIAGNOSTIC_ERROR_BYTES = 256 * 1024;
export const MAX_DIAGNOSTIC_FILE_BYTES = 512 * 1024;
export const MAX_DIAGNOSTIC_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_DIAGNOSTIC_ENTRIES = 2_048;
export const MAX_DIAGNOSTIC_DIRECTORY_DEPTH = 64;
export const MAX_GOLDEN_ISSUE_TREE_DEPTH = 32;
const DIAGNOSTIC_ROOT_NAME = "symphony-e2e-diagnostics";
const DIAGNOSTIC_DIR_PREFIX = "golden-failure-";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_GOLDEN_CRITIC_RESULT_BYTES = 64 * 1024;
const GOLDEN_CRITIC_RESULT_TIMEOUT_MS = 15_000;
const GOLDEN_NEEDS_HUMAN_MARKER = "# Symphony Harness: Human Action";
const GOLDEN_NEEDS_HUMAN_DEFAULT_OPTION = "default_file";
const GOLDEN_NEEDS_HUMAN_ALTERNATE_OPTION = "alternate_file";
const GOLDEN_HUMAN_ACTION_SCENARIOS = Object.freeze([
  "single-cycle-human-action",
  "cycle-human-action-cycle",
  "human-action-rejected-supplement",
  "human-action-unanswered",
]);

function absolutePath(value) {
  return typeof value === "string" && value.length > 0 && path.isAbsolute(value) && !value.includes("\0");
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value === undefined || value === null) return Buffer.alloc(0);
  return Buffer.from(String(value), "utf8");
}

function boundedText(value, maximum = MAX_DIAGNOSTIC_STREAM_BYTES) {
  const source = asBuffer(value);
  return source.byteLength <= maximum
    ? source.toString("utf8")
    : source.subarray(0, maximum).toString("utf8");
}

function readProperty(value, key) {
  try {
    return value?.[key];
  } catch {
    return undefined;
  }
}

function serializeErrorValue(value, state, depth = 0) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return String(value);
    if (typeof value === "function" || typeof value === "symbol") return String(value);
    return value;
  }
  if (depth > 8) return "[MaxDepth]";
  if (state.seen.has(value)) return "[Circular]";
  state.seen.add(value);
  if (value instanceof Error || typeof readProperty(value, "message") === "string") {
    return serializeError(value, state, depth + 1);
  }
  const result = {};
  for (const key of Object.keys(value).slice(0, 64)) {
    result[key] = serializeErrorValue(readProperty(value, key), state, depth + 1);
  }
  return result;
}

function serializeError(error, state = { seen: new Set() }, depth = 0) {
  const source = error instanceof Error || (error !== null && typeof error === "object")
    ? error
    : new Error(String(error ?? "golden_unknown_failure"));
  const result = {
    name: boundedText(readProperty(source, "name") ?? "Error", 16 * 1024),
    message: boundedText(readProperty(source, "message") ?? String(source), MAX_DIAGNOSTIC_ERROR_BYTES / 4),
    stack: boundedText(readProperty(source, "stack") ?? "", MAX_DIAGNOSTIC_ERROR_BYTES / 2),
  };
  if (Object.prototype.hasOwnProperty.call(source, "cause") || readProperty(source, "cause") !== undefined) {
    result.cause = serializeErrorValue(readProperty(source, "cause"), state, depth + 1);
  }
  return result;
}

function encodeError(error) {
  const record = serializeError(error);
  const encoded = Buffer.from(JSON.stringify(record), "utf8");
  if (encoded.byteLength <= MAX_DIAGNOSTIC_ERROR_BYTES) return encoded;
  return Buffer.from(JSON.stringify({
    name: boundedText(record.name, 8 * 1024),
    message: boundedText(record.message, 16 * 1024),
    stack: boundedText(record.stack, 32 * 1024),
    cause: "[Truncated]",
  }), "utf8");
}

async function writePrivateFile(filePath, contents) {
  const handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, PRIVATE_FILE_MODE);
  try {
    const source = asBuffer(contents);
    let offset = 0;
    while (offset < source.byteLength) {
      const { bytesWritten } = await handle.write(source, offset, source.byteLength - offset);
      if (bytesWritten < 1) throw new Error("golden_diagnostic_archive_write_failed");
      offset += bytesWritten;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  await chmod(filePath, PRIVATE_FILE_MODE);
}

async function readBoundedFile(filePath, maximum) {
  const handle = await open(filePath, constants.O_RDONLY | NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("golden_diagnostic_archive_unsafe");
    const length = Math.min(metadata.size, maximum);
    const output = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(output, offset, length - offset, offset);
      if (bytesRead < 1) break;
      offset += bytesRead;
    }
    return { contents: output.subarray(0, offset), bytes: metadata.size };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function ensurePrivateDirectory(directory, { allowCreate = true } = {}) {
  if (!absolutePath(directory)) throw new Error("golden_diagnostic_archive_unsafe");
  let created = false;
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (!allowCreate || error?.code !== "ENOENT") throw new Error("golden_diagnostic_archive_unsafe");
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    created = true;
    metadata = await lstat(directory);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("golden_diagnostic_archive_unsafe");
  if (!created && (metadata.mode & 0o077) !== 0) throw new Error("golden_diagnostic_archive_unsafe");
  await chmod(directory, PRIVATE_DIRECTORY_MODE);
  const verified = await lstat(directory);
  if (!verified.isDirectory() || verified.isSymbolicLink() || (verified.mode & 0o077) !== 0) {
    throw new Error("golden_diagnostic_archive_unsafe");
  }
  return realpath(directory);
}

async function copyRunDirectory(source, destination, state, depth = 0) {
  if (depth > MAX_DIAGNOSTIC_DIRECTORY_DEPTH) {
    throw new Error("golden_diagnostic_archive_depth_exceeded");
  }
  const sourceMetadata = await lstat(source);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error("golden_diagnostic_archive_unsafe");
  }
  await mkdir(destination, { mode: PRIVATE_DIRECTORY_MODE });
  await chmod(destination, PRIVATE_DIRECTORY_MODE);
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    state.entries += 1;
    if (state.entries > MAX_DIAGNOSTIC_ENTRIES || entry.name.includes("\0")) {
      throw new Error("golden_diagnostic_archive_unsafe");
    }
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink()) throw new Error("golden_diagnostic_archive_unsafe");
    if (metadata.isDirectory()) {
      await copyRunDirectory(sourcePath, destinationPath, state, depth + 1);
      continue;
    }
    if (!metadata.isFile()) throw new Error("golden_diagnostic_archive_unsafe");
    const remaining = Math.max(0, MAX_DIAGNOSTIC_TOTAL_BYTES - state.bytes);
    if (remaining === 0) throw new Error("golden_diagnostic_archive_size_exceeded");
    const bounded = await readBoundedFile(sourcePath, Math.min(MAX_DIAGNOSTIC_FILE_BYTES, remaining));
    state.bytes += bounded.contents.byteLength;
    await writePrivateFile(destinationPath, bounded.contents);
  }
}

async function nearestExistingAncestor(directory) {
  let candidate = directory;
  for (;;) {
    try {
      return { path: candidate, metadata: await lstat(candidate) };
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error("golden_diagnostic_archive_unsafe");
      const parent = path.dirname(candidate);
      if (parent === candidate) throw new Error("golden_diagnostic_archive_unsafe");
      candidate = parent;
    }
  }
}

async function archiveRootFor({ archiveRoot, runDirectory }) {
  if (!absolutePath(runDirectory)) throw new Error("golden_diagnostic_archive_unsafe");
  const runReal = await realpath(runDirectory).catch(() => { throw new Error("golden_diagnostic_archive_unsafe"); });
  const fixtureRoot = path.dirname(runReal);
  const requestedInput = archiveRoot ?? path.join(os.tmpdir(), DIAGNOSTIC_ROOT_NAME);
  if (!absolutePath(requestedInput)) throw new Error("golden_diagnostic_archive_unsafe");
  const requested = path.resolve(requestedInput);
  if (!absolutePath(requested) || inside(fixtureRoot, requested)) {
    throw new Error("golden_diagnostic_archive_unsafe");
  }
  const ancestor = await nearestExistingAncestor(requested);
  if (!ancestor.metadata.isDirectory() || ancestor.metadata.isSymbolicLink()) {
    throw new Error("golden_diagnostic_archive_unsafe");
  }
  const ancestorReal = await realpath(ancestor.path).catch(() => { throw new Error("golden_diagnostic_archive_unsafe"); });
  if (inside(fixtureRoot, ancestorReal)) throw new Error("golden_diagnostic_archive_unsafe");
  const root = await ensurePrivateDirectory(requested);
  if (inside(fixtureRoot, root)) throw new Error("golden_diagnostic_archive_unsafe");
  return root;
}

/**
 * Persist raw failure context before the caller removes its temporary fixture.
 * The returned path is the only diagnostic detail intended for public output.
 */
export async function archiveGoldenFailure({
  archiveRoot,
  runDirectory,
  error,
  stdout,
  stderr,
} = {}) {
  if (!absolutePath(runDirectory)) throw new Error("golden_diagnostic_archive_unsafe");
  const runMetadata = await lstat(runDirectory).catch(() => { throw new Error("golden_diagnostic_archive_unsafe"); });
  if (!runMetadata.isDirectory() || runMetadata.isSymbolicLink()) {
    throw new Error("golden_diagnostic_archive_unsafe");
  }
  const root = await archiveRootFor({ archiveRoot, runDirectory });
  const runReal = await realpath(runDirectory).catch(() => { throw new Error("golden_diagnostic_archive_unsafe"); });
  if (inside(runReal, root)) throw new Error("golden_diagnostic_archive_unsafe");
  const archiveDirectory = await mkdtemp(path.join(root, DIAGNOSTIC_DIR_PREFIX));
  let verifiedArchive;
  try {
    await chmod(archiveDirectory, PRIVATE_DIRECTORY_MODE);
    const metadata = await lstat(archiveDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw new Error("golden_diagnostic_archive_unsafe");
    }
    verifiedArchive = await realpath(archiveDirectory);
    const runDestination = path.join(verifiedArchive, "run_directory");
    const state = { bytes: 0, entries: 0 };
    const errorContents = encodeError(error);
    await writePrivateFile(path.join(verifiedArchive, "error.json"), errorContents);
    const childStdout = asBuffer(stdout).subarray(0, MAX_DIAGNOSTIC_STREAM_BYTES);
    const childStderr = asBuffer(stderr).subarray(0, MAX_DIAGNOSTIC_STREAM_BYTES);
    await writePrivateFile(path.join(verifiedArchive, "stdout.log"), childStdout);
    await writePrivateFile(path.join(verifiedArchive, "stderr.log"), childStderr);
    state.bytes = errorContents.byteLength + childStdout.byteLength + childStderr.byteLength;
    if (state.bytes > MAX_DIAGNOSTIC_TOTAL_BYTES) {
      throw new Error("golden_diagnostic_archive_size_exceeded");
    }
    await copyRunDirectory(runDirectory, runDestination, state);
    return Object.freeze({ diagnostic_ref: verifiedArchive });
  } catch (error) {
    await rm(archiveDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error instanceof Error && error.message.startsWith("golden_diagnostic_archive_")
      ? error
      : new Error("golden_diagnostic_archive_failed", { cause: error });
  }
}

export async function graphql(token, query, variables, request = fetch) {
  let response;
  try {
    response = await request(ENDPOINT, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  if (!response.ok) throw new Error(response.statusText || `HTTP ${response.status}`);
  const envelope = await response.json().catch(() => null);
  if (envelope === null || typeof envelope !== "object" || !envelope.data || envelope.errors?.length) {
    throw new Error("golden_linear_response_invalid");
  }
  return envelope.data;
}

export async function createLinearRoot(environment, runId, scenario = "single-cycle-human-action") {
  const token = environment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN;
  const slug = environment.SYMPHONY_E2E_PROJECT_SLUG_ID;
  const catalog = await graphql(token, `query GoldenProject($slug: String!) {
    projects(first: 2, filter: { slugId: { eq: $slug } }) {
      nodes { id teams(first: 2) { nodes { id } pageInfo { hasNextPage } } }
      pageInfo { hasNextPage }
    }
  }`, { slug });
  const projects = catalog.projects;
  if (projects?.pageInfo?.hasNextPage || projects?.nodes?.length !== 1) {
    throw new Error("golden_project_identity_invalid");
  }
  const project = projects.nodes[0];
  if (project.teams?.pageInfo?.hasNextPage || project.teams?.nodes?.length !== 1) {
    throw new Error("golden_team_identity_invalid");
  }
  const teamId = project.teams.nodes[0].id;
  const stateCatalog = await graphql(token, `query GoldenTodoState($teamId: ID!) {
    workflowStates(
      filter: { team: { id: { eq: $teamId } }, name: { eq: "Todo" } }
      first: 10
    ) {
      nodes { id name type team { id } }
      pageInfo { hasNextPage }
    }
  }`, { teamId });
  const stateConnection = stateCatalog.workflowStates;
  const todoStates = Array.isArray(stateConnection?.nodes)
    ? stateConnection.nodes.filter((state) => state?.name === "Todo"
      && state?.type === "unstarted"
      && state?.team?.id === teamId
      && typeof state?.id === "string" && state.id.length > 0)
    : [];
  if (stateConnection?.pageInfo?.hasNextPage !== false || todoStates.length !== 1) {
    throw new Error("golden_team_todo_state_invalid");
  }
  const stateId = todoStates[0].id;
  const filename = `symphony-golden-${runId}.txt`;
  const expectedContent = `Symphony golden E2E ${runId}`;
  const expectedBytes = Buffer.byteLength(expectedContent, "utf8");
  const stagingFilename = `symphony-golden-${runId}-staging.txt`;
  const stagingContent = `Symphony staging E2E ${runId}`;
  const stagingBytes = Buffer.byteLength(stagingContent, "utf8");
  const humanGate = GOLDEN_HUMAN_ACTION_SCENARIOS.includes(scenario);
  const scenarioRequirement = scenario === "multi-cycle"
    ? "The first Cycle must be rejected as incomplete, then a repair Cycle must produce the accepted result."
    : scenario === "cycle-human-action-cycle"
      ? `The first Cycle must create ${stagingFilename} containing exactly these ${stagingBytes} UTF-8 bytes: ${stagingContent}. It must receive an accepted Critic before asking the filename Human Action question. After the reply, the second Cycle must delete the staging file and create the selected final file.`
      : scenario === "human-action-rejected-supplement"
        ? "Reject the first batch of Human Action replies, ask one follow-up in the same thread, then accept the later supplement without creating another top-level action."
        : scenario === "human-action-unanswered"
          ? "Leave the Human Action unanswered. The Root must remain Needs Human without creating a Cycle or attempting delivery."
      : "";
  const humanRequirement = scenario === "cycle-human-action-cycle"
    ? [
      "Do not ask for Human Action before the first Cycle and its accepted Critic are complete.",
      "After that first accepted Cycle, ask exactly one concrete question: Which output filename should this run create?",
      "Use these two mutually exclusive options in that question:",
      `- ${GOLDEN_NEEDS_HUMAN_DEFAULT_OPTION}: create ${filename} with the exact bytes below.`,
      `- ${GOLDEN_NEEDS_HUMAN_ALTERNATE_OPTION}: create symphony-golden-${runId}-alternate.txt instead.`,
      `Do not create the final output until a Root reply explicitly selects ${GOLDEN_NEEDS_HUMAN_DEFAULT_OPTION}.`,
    ]
    : humanGate ? [
      "The first Root Reconcile decision MUST be `needs_human` before any workspace change, with exactly one concrete question: Which output filename should this run create?",
      "Use these two mutually exclusive options in that question:",
      `- ${GOLDEN_NEEDS_HUMAN_DEFAULT_OPTION}: create ${filename} with the exact bytes below.`,
      `- ${GOLDEN_NEEDS_HUMAN_ALTERNATE_OPTION}: create symphony-golden-${runId}-alternate.txt instead.`,
      `Do not create a Cycle or modify the workspace until a Root reply explicitly selects ${GOLDEN_NEEDS_HUMAN_DEFAULT_OPTION}.`,
    ] : [];
  const created = await graphql(token, `mutation GoldenRoot($input: IssueCreateInput!) {
    issueCreate(input: $input) { success issue { id identifier url } }
  }`, {
    input: {
      teamId,
      projectId: project.id,
      stateId,
      title: `[E2E] Symphony golden Root ${runId}`,
      description: [
        ...humanRequirement,
        scenarioRequirement,
        `Create ${filename} containing exactly these ${expectedBytes} UTF-8 bytes: ${expectedContent}`,
        "The file must match those bytes exactly, with no trailing newline or other additional content.",
        "Verify the byte-for-byte file content and the complete workspace diff.",
        "Do not modify .env, credentials, Git configuration, or unrelated files.",
      ].join("\n\n"),
    },
  });
  if (created.issueCreate?.success !== true || typeof created.issueCreate.issue?.identifier !== "string") {
    throw new Error("golden_root_create_failed");
  }
  return Object.freeze({ ...created.issueCreate.issue, filename });
}

function parseGoldenNeedsHumanQuestionBody(body, expectedOptionKeys = []) {
  if (typeof body !== "string" || !body.startsWith(`${GOLDEN_NEEDS_HUMAN_MARKER}\n`)) {
    throw new Error("golden_needs_human_question_invalid");
  }
  const lines = body.split(/\r?\n/u);
  if (!lines.includes("## Questions")) throw new Error("golden_needs_human_question_invalid");
  const questions = [];
  let current;
  for (const line of lines) {
    const question = /^### [1-9][0-9]*\. ([^\r\n]+)$/u.exec(line);
    if (question !== null) {
      current = { question: question[1], options: [] };
      questions.push(current);
      continue;
    }
    const option = /^- \*\*([A-Za-z][A-Za-z0-9_-]{0,63})\. ([^*\r\n]+)\*\*: ([^\r\n]+)$/u.exec(line);
    if (option !== null && current !== undefined) {
      current.options.push({ key: option[1], label: option[2], consequence: option[3] });
    }
  }
  if (questions.length < 1 || questions.some((question) => (
    question.options.length < 2
    || question.options.length > 4
    || new Set(question.options.map(({ key }) => key)).size !== question.options.length
    || question.options.some(({ label, consequence }) => label.trim().length === 0 || consequence.trim().length === 0)
  ))) {
    throw new Error("golden_needs_human_question_options_invalid");
  }
  const expected = [...expectedOptionKeys];
  if (expected.length > 0 && expected.some((key) => !questions[0].options.some((option) => option.key === key))) {
    throw new Error("golden_needs_human_question_options_invalid");
  }
  return Object.freeze({ body, questions: Object.freeze(questions.map((question) => Object.freeze({
    question: question.question,
    options: Object.freeze(question.options.map((option) => Object.freeze({ ...option }))),
  }))) });
}

function goldenRootCommentBodies(comments) {
  if (!Array.isArray(comments) || comments.some((comment) => (
    comment === null || typeof comment !== "object" || typeof comment.body !== "string"
  ))) {
    throw new Error("golden_needs_human_comments_invalid");
  }
  return comments;
}

export function validateGoldenNeedsHumanQuestion(comments, expectedOptionKeys = []) {
  const entries = goldenRootCommentBodies(comments);
  const questionComments = entries.filter(({ body }) => body.startsWith(`${GOLDEN_NEEDS_HUMAN_MARKER}\n`));
  if (questionComments.length !== 1
    || entries.some(({ body }) => body.startsWith("# Symphony Harness:")
      && !body.startsWith(`${GOLDEN_NEEDS_HUMAN_MARKER}\n`))) {
    throw new Error("golden_needs_human_question_count_invalid");
  }
  return parseGoldenNeedsHumanQuestionBody(questionComments[0].body, expectedOptionKeys);
}

export function validateGoldenNeedsHumanReply(comments, replyId, expectedBody) {
  const entries = goldenRootCommentBodies(comments);
  const question = entries.find(({ body }) => body.startsWith(`${GOLDEN_NEEDS_HUMAN_MARKER}\n`));
  validateGoldenNeedsHumanQuestion(entries);
  const replies = entries.filter(({ body }) => !body.startsWith(`${GOLDEN_NEEDS_HUMAN_MARKER}\n`));
  if (replies.length !== 1) throw new Error("golden_needs_human_reply_count_invalid");
  const reply = replies[0];
  if ((replyId !== undefined && reply.id !== replyId)
    || (expectedBody !== undefined && reply.body !== expectedBody)) {
    throw new Error("golden_needs_human_reply_invalid");
  }
  if (question?.id !== undefined && reply.parent?.id !== question.id) {
    throw new Error("golden_needs_human_reply_parent_invalid");
  }
  const reactions = goldenCommentReactions(reply);
  if (!reactions.includes("white_check_mark")) {
    throw new Error("golden_needs_human_reply_not_accepted");
  }
  return reply;
}

function goldenNeedsHumanQuestion(entries) {
  const questions = entries.filter(({ body, parent }) => (
    body.startsWith(`${GOLDEN_NEEDS_HUMAN_MARKER}\n`)
      && (parent?.id === undefined || parent?.id === null)
  ));
  if (questions.length !== 1) throw new Error("golden_needs_human_question_count_invalid");
  parseGoldenNeedsHumanQuestionBody(questions[0].body);
  return questions[0];
}

function goldenCommentReactions(comment) {
  const reactions = comment?.reactions;
  if (!Array.isArray(reactions)
    || reactions.some((reaction) => reaction === null || typeof reaction !== "object")) {
    throw new Error("golden_needs_human_reply_reactions_invalid");
  }
  return reactions.map(({ emoji }) => emoji);
}

/**
 * Validate one rejected direct-reply batch and its in-thread Harness follow-up.
 * The user replies are intentionally identified by their non-Harness body: the
 * fixture token is human-authored, while Conductor follow-ups carry its marker.
 */
export function validateGoldenNeedsHumanRejectedBatch(comments, expectedReplyIds = []) {
  const entries = goldenRootCommentBodies(comments);
  const question = goldenNeedsHumanQuestion(entries);
  const directReplies = entries.filter(({ parent }) => parent?.id === question.id);
  const userReplies = directReplies.filter(({ body }) => !body.startsWith("# Symphony Harness:"));
  const followUps = directReplies.filter(({ body }) => body.startsWith("# Symphony Harness:"));
  if (userReplies.length < 1 || followUps.length !== 1) {
    throw new Error("golden_needs_human_rejection_thread_invalid");
  }
  const expected = [...expectedReplyIds];
  if (expected.length > 0
    && (expected.length !== userReplies.length || expected.some((id) => !userReplies.some((reply) => reply.id === id)))) {
    throw new Error("golden_needs_human_rejection_reply_invalid");
  }
  for (const reply of userReplies) {
    const reactions = goldenCommentReactions(reply);
    if (reactions.filter((emoji) => emoji === "x").length !== 1
      || reactions.includes("white_check_mark")) {
      throw new Error("golden_needs_human_rejection_not_marked");
    }
  }
  if (goldenCommentReactions(followUps[0]).length !== 0
    || !followUps[0].body.includes("## Questions")) {
    throw new Error("golden_needs_human_follow_up_invalid");
  }
  return Object.freeze({ question, userReplies, followUp: followUps[0] });
}

export function validateGoldenNeedsHumanSupplement(comments, supplementReplyId) {
  const entries = goldenRootCommentBodies(comments);
  const question = goldenNeedsHumanQuestion(entries);
  const directReplies = entries.filter(({ parent }) => parent?.id === question.id);
  const supplement = directReplies.find(({ id }) => id === supplementReplyId);
  if (supplement === undefined || supplement.body.startsWith("# Symphony Harness:")) {
    throw new Error("golden_needs_human_supplement_invalid");
  }
  const reactions = goldenCommentReactions(supplement);
  if (reactions.filter((emoji) => emoji === "white_check_mark").length !== 1
    || reactions.includes("x")) {
    throw new Error("golden_needs_human_supplement_not_accepted");
  }
  if (directReplies.filter(({ body }) => body.startsWith("# Symphony Harness:")).length !== 1) {
    throw new Error("golden_needs_human_follow_up_count_invalid");
  }
  for (const reply of directReplies.filter(({ body, id }) => (
    id !== supplementReplyId && !body.startsWith("# Symphony Harness:")
  ))) {
    const priorReactions = goldenCommentReactions(reply);
    if (priorReactions.filter((emoji) => emoji === "x").length !== 1
      || priorReactions.includes("white_check_mark")) {
      throw new Error("golden_needs_human_rejection_not_marked");
    }
  }
  return supplement;
}

export function validateGoldenNeedsHumanUnanswered(issue, comments) {
  if (issue?.state?.name !== "Needs Human" || issue.state.type !== "started"
    || !visibleConnection(issue.children) || issue.children.nodes.length !== 0) {
    throw new Error("golden_needs_human_unanswered_state_invalid");
  }
  const entries = goldenRootCommentBodies(comments);
  const question = goldenNeedsHumanQuestion(entries);
  if (entries.some(({ parent }) => parent?.id === question.id)
    || entries.some((comment) => goldenCommentReactions(comment).length > 0)) {
    throw new Error("golden_needs_human_unanswered_reply_invalid");
  }
  return question;
}

async function listGoldenNeedsHumanComments(token, rootId, includeReactions = false) {
  const reactionFields = includeReactions
    ? "reactions { emoji }"
    : "";
  const data = await graphql(token, `query GoldenNeedsHuman($id: String!) {
    issue(id: $id) {
      comments(first: 50) {
        nodes {
          id body parent { id } ${reactionFields}
          children(first: 50) {
            nodes { id body parent { id } ${reactionFields} }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  }`, { id: rootId });
  const connection = data.issue?.comments;
  if (connection?.pageInfo?.hasNextPage !== false || !Array.isArray(connection?.nodes)) {
    throw new Error("golden_needs_human_comments_incomplete");
  }
  const entries = [];
  for (const comment of connection.nodes) {
    if (comment?.children?.pageInfo?.hasNextPage !== false || !Array.isArray(comment?.children?.nodes)) {
      throw new Error("golden_needs_human_replies_incomplete");
    }
    if (comment.parent?.id === undefined || comment.parent?.id === null) {
      entries.push(comment);
      entries.push(...comment.children.nodes);
    }
  }
  return entries;
}

async function verifyGoldenNeedsHumanQuestion(token, rootId, expectedOptionKeys) {
  const comments = await listGoldenNeedsHumanComments(token, rootId);
  if (comments.length !== 1) throw new Error("golden_needs_human_initial_comments_invalid");
  const parsed = validateGoldenNeedsHumanQuestion(comments, expectedOptionKeys);
  return Object.freeze({ ...parsed, request_comment_id: comments[0].id });
}

async function createGoldenHumanReply(token, rootId, parentId, body) {
  const created = await graphql(token, `mutation GoldenHumanReply($input: CommentCreateInput!) {
    commentCreate(input: $input) { success comment { id body issue { id } parent { id } } }
  }`, { input: { issueId: rootId, parentId, body } });
  if (created.commentCreate?.success !== true
    || typeof created.commentCreate.comment?.id !== "string"
    || created.commentCreate.comment.issue?.id !== rootId
    || created.commentCreate.comment.parent?.id !== parentId) {
    throw new Error("golden_needs_human_reply_create_failed");
  }
  return Object.freeze({
    id: created.commentCreate.comment.id,
    body: created.commentCreate.comment.body,
  });
}

async function verifyGoldenNeedsHumanAcceptance(token, rootId, replyId, replyBody) {
  const comments = await listGoldenNeedsHumanComments(token, rootId, true);
  validateGoldenNeedsHumanReply(comments, replyId, replyBody);
}

async function verifyGoldenNeedsHumanRejected(token, rootId, expectedReplyIds) {
  const comments = await listGoldenNeedsHumanComments(token, rootId, true);
  return validateGoldenNeedsHumanRejectedBatch(comments, expectedReplyIds);
}

async function verifyGoldenNeedsHumanSupplement(token, rootId, supplementReplyId) {
  const comments = await listGoldenNeedsHumanComments(token, rootId, true);
  return validateGoldenNeedsHumanSupplement(comments, supplementReplyId);
}

async function verifyGoldenNeedsHumanUnanswered(token, rootId) {
  const data = await graphql(token, `query GoldenNeedsHumanUnanswered($id: String!) {
    issue(id: $id) {
      state { name type }
      children(first: 10) {
        nodes { id }
        pageInfo { hasNextPage }
      }
    }
  }`, { id: rootId });
  const issue = data.issue;
  if (issue?.children?.pageInfo?.hasNextPage !== false || !Array.isArray(issue?.children?.nodes)) {
    throw new Error("golden_needs_human_unanswered_children_invalid");
  }
  const comments = await listGoldenNeedsHumanComments(token, rootId, true);
  return validateGoldenNeedsHumanUnanswered(issue, comments);
}

export async function archiveIssueTree(token, rootId) {
  const pending = [{ issueId: rootId, depth: 0 }];
  const ordered = [];
  while (pending.length > 0) {
    const entry = pending.shift();
    if (entry.depth > MAX_GOLDEN_ISSUE_TREE_DEPTH) {
      throw new Error("golden_issue_cleanup_depth_exceeded");
    }
    const { issueId } = entry;
    const data = await graphql(token, `query GoldenChildren($id: String!) {
      issue(id: $id) { children(first: 50) { nodes { id } pageInfo { hasNextPage } } }
    }`, { id: issueId });
    if (data.issue?.children?.pageInfo?.hasNextPage) throw new Error("golden_cleanup_page_incomplete");
    const children = data.issue?.children?.nodes ?? [];
    pending.push(...children.map(({ id }) => ({ issueId: id, depth: entry.depth + 1 })));
    ordered.push(issueId);
  }
  for (const issueId of ordered.reverse()) {
    const result = await graphql(token, `mutation GoldenArchive($id: String!) {
      issueArchive(id: $id) { success }
    }`, { id: issueId });
    if (result.issueArchive?.success !== true) throw new Error("golden_issue_cleanup_failed");
  }
}

function exactObject(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function canonicalDone(issue) {
  // Golden reads one final provider snapshot. Linear does not expose transition
  // history here, so this validator checks only the canonical terminal state.
  return exactObject(issue?.state, ["name", "type"])
    && issue.state.name === "Done" && issue.state.type === "completed";
}

function roleTitle(title, prefix, cycleNumber) {
  return title === `${prefix} Cycle ${cycleNumber}`;
}

function visibleConnection(connection) {
  return exactObject(connection, ["nodes", "pageInfo"])
    && Array.isArray(connection.nodes)
    && exactObject(connection.pageInfo, ["hasNextPage"])
    && connection.pageInfo.hasNextPage === false;
}

export function validateGoldenVisibleTree(issue) {
  if (!exactObject(issue, ["state", "children"]) || !canonicalDone(issue)
    || !visibleConnection(issue.children)) {
    throw new Error("golden_visible_root_state_invalid");
  }
  const cycles = issue.children?.nodes;
  if (!Array.isArray(cycles) || cycles.length < 1) throw new Error("golden_visible_cycle_missing");
  for (const cycle of cycles) {
    const cycleTitle = typeof cycle?.title === "string"
      ? /^\[Cycle ([0-9]{3})\] ([^\r\n]{1,68})$/u.exec(cycle.title)
      : null;
    if (!exactObject(cycle, ["title", "state", "children"])
      || cycleTitle === null
      || !canonicalDone(cycle)
      || !visibleConnection(cycle.children)) {
      throw new Error("golden_visible_cycle_state_invalid");
    }
    const roles = cycle.children?.nodes;
    if (!Array.isArray(roles) || roles.length !== 2
      || !["[Critic]", "[Artist]"].every((prefix) => roles.some((role) => roleTitle(role?.title, prefix, cycleTitle[1])))
      || roles.some((role) => !exactObject(role, ["title", "state", "children"]))) {
      throw new Error("golden_visible_role_topology_invalid");
    }
    if (roles.some((role) => !canonicalDone(role))) throw new Error("golden_visible_role_state_invalid");
    if (roles.some((role) => !visibleConnection(role.children) || role.children.nodes.length !== 0)) {
      throw new Error("golden_visible_role_topology_invalid");
    }
  }
}

function commentConnection(connection) {
  return exactObject(connection, ["nodes", "pageInfo"])
    && Array.isArray(connection.nodes)
    && connection.nodes.every((comment) => exactObject(comment, ["body"]) && typeof comment.body === "string")
    && exactObject(connection.pageInfo, ["hasNextPage"])
    && connection.pageInfo.hasNextPage === false;
}

const ARTIST_REPORT_HEADINGS = Object.freeze([
  "## Summary", "## File Changes", "### Created", "### Updated", "### Deleted", "## Verification",
]);
const RAW_GIT_PORCELAIN_LINE = /^(?:(?:\?\?|[ MADRCU?!]{1,2}) |[12u?!] )[^\r\n]+$/u;
const LOCAL_TIMESTAMP = /^Updated at: [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT[+-][0-9]{2}:[0-9]{2}$/u;

function descriptionResult(description, separator) {
  const start = description.lastIndexOf(separator);
  if (start < 0) return undefined;
  const projection = description.slice(start + separator.length);
  const boundary = projection.indexOf("\n\n");
  return boundary >= 0 && projection.startsWith("Updated at: ")
    ? projection.slice(boundary + 2)
    : projection;
}

function validCriticMarkdown(body) {
  if (typeof body !== "string") return false;
  const match = /^```json\n([^\n]+)\n```\n\n([\s\S]+)$/u.exec(body.trim());
  if (match?.[1] === undefined || match[2]?.trim().length === 0) return false;
  try {
    return validCriticEnvelope(JSON.parse(match[1]));
  } catch {
    return false;
  }
}

function validArtistHumanReport(body) {
  if (typeof body !== "string") return false;
  const lines = body.split(/\r?\n/u);
  if (lines.some((line) => RAW_GIT_PORCELAIN_LINE.test(line))) return false;
  const indexes = ARTIST_REPORT_HEADINGS.map((heading) => lines.indexOf(heading));
  if (indexes[0] !== 0 || indexes.some((index) => index < 0)
    || indexes.some((index, position) => position > 0 && index <= indexes[position - 1])) {
    return false;
  }
  for (let position = 2; position <= 4; position += 1) {
    const entries = lines.slice(indexes[position] + 1, indexes[position + 1]).filter((line) => line.length > 0);
    if (entries.length === 0 || entries.some((line) => !/^(?:-|\*) /u.test(line))) return false;
  }
  return true;
}

function validArtistErrorReport(body) {
  if (typeof body !== "string") return false;
  const lines = body.split(/\r?\n/u);
  const error = lines.find((line) => line.startsWith("- Error: "))?.slice("- Error: ".length);
  return lines[0] === "## Artist Result"
    && lines.includes("- Result: failure")
    && typeof error === "string" && error.length > 0 && error.length <= 50
    && !/[\r\n\0]/u.test(error);
}

function orderedHeadings(lines, headings) {
  const indexes = headings.map((heading) => lines.indexOf(heading));
  return indexes[0] >= 0
    && indexes.every((index) => index >= 0)
    && indexes.every((index, position) => position === 0 || index > indexes[position - 1]);
}

function validRootReconcileReport(body, kind) {
  if (typeof body !== "string" || !body.startsWith("# Symphony Harness: Reconcile\n\n")) return false;
  const lines = body.split(/\r?\n/u);
  if (lines.some((line) => RAW_GIT_PORCELAIN_LINE.test(line))) return false;
  if (kind === "cycle") {
    return orderedHeadings(lines, ["### Why Continue", "### Evidence", "### Next Cycle"]);
  }
  if (!orderedHeadings(lines, [
    "### Overview", "### File Changes", "#### Created", "#### Updated", "#### Deleted",
    "### Line Changes", "### Verification", "### Run Metrics",
  ])) return false;
  return lines.some((line) => /^Duration: (?:[0-9]+ms|[0-9]+s|[0-9]+m [0-9]+s)$/u.test(line))
    && lines.some((line) => /^Total tokens: (?:Unknown|[0-9]+(?:\.[0-9])?[kM]?)$/u.test(line));
}

function validGoldenNeedsHumanRootComments(comments) {
  if (!comments.some(({ body }) => body.startsWith("# Symphony Harness:"))) return true;
  try {
    goldenNeedsHumanQuestion(comments);
    return true;
  } catch {
    return false;
  }
}

function validateArchitectureDecisionProjection(issue, scenario) {
  const humanScenario = scenario === "single-cycle-human-action"
    || scenario === "cycle-human-action-cycle"
    || scenario === "human-action-rejected-supplement";
  if (!humanScenario) return;
  if (!issue.description.includes("ADR-001")) throw new Error("golden_architecture_decision_root_invalid");
  const cycles = issue.children.nodes;
  const targetNumber = scenario === "cycle-human-action-cycle" ? "002" : "001";
  const target = cycles.find((cycle) => cycle.title?.startsWith(`[Cycle ${targetNumber}]`));
  if (target === undefined || !target.description?.includes("ADR-001")) {
    throw new Error("golden_architecture_decision_cycle_missing");
  }
}

export function validateGoldenResultComments(issue, { scenario } = {}) {
  if (!exactObject(issue, ["description", "comments", "children"])
    || typeof issue.description !== "string"
    || !commentConnection(issue.comments)
    || !visibleConnection(issue.children)) {
    throw new Error("golden_result_comments_root_invalid");
  }
  const cycles = issue.children.nodes;
  if (cycles.length < 1) throw new Error("golden_result_comments_cycle_missing");
  const managedStart = issue.description.indexOf("\n\n# Symphony Harness: Managed Root\n");
  const managedEnd = issue.description.lastIndexOf("\n\n# Symphony Harness: End Managed Root");
  const reconcileStart = issue.description.indexOf("\n\n## Result\n", managedStart);
  const deliveryStart = issue.description.indexOf("\n\n## Delivery\n", reconcileStart);
  const metadataStart = issue.description.indexOf("\n\n## Metadata\n", reconcileStart);
  if (managedStart < 1 || managedEnd <= managedStart || reconcileStart <= managedStart
    || metadataStart <= reconcileStart
    || (deliveryStart >= 0 && deliveryStart >= metadataStart)
    || !issue.description.includes("\n\n### Root State\n", managedStart)
    || !issue.description.slice(managedStart, managedEnd).split(/\r?\n/u).some((line) => LOCAL_TIMESTAMP.test(line))
    || !validGoldenNeedsHumanRootComments(issue.comments.nodes)) {
    throw new Error("golden_root_description_invalid");
  }
  const completionReport = `# Symphony Harness: Reconcile\n${issue.description.slice(
    reconcileStart + "\n\n## Result".length,
    deliveryStart >= 0 ? deliveryStart : metadataStart,
  )}`;
  if (!validRootReconcileReport(completionReport, "complete")) {
    throw new Error("golden_root_description_invalid");
  }
  const critiqueResultUrls = [];
  for (const cycle of cycles) {
    const cycleTitle = typeof cycle?.title === "string"
      ? /^\[Cycle ([0-9]{3})\] [^\r\n]{1,68}$/u.exec(cycle.title)
      : null;
    if (cycleTitle === null || !commentConnection(cycle.comments) || !visibleConnection(cycle.children)) {
      throw new Error("golden_result_comments_cycle_invalid");
    }
    const roles = cycle.children.nodes;
    const artist = roles.find((role) => role?.title === `[Artist] Cycle ${cycleTitle[1]}`);
    const audit = roles.find((role) => role?.title === `[Critic] Cycle ${cycleTitle[1]}`);
    if (artist === undefined || audit === undefined
      || typeof artist.description !== "string" || typeof audit.description !== "string"
      || typeof audit.identifier !== "string" || typeof audit.url !== "string"
      || !commentConnection(artist.comments) || !commentConnection(audit.comments)) {
      throw new Error("golden_result_comments_role_invalid");
    }
    const resultSeparator = "\n\n# Result\n\n";
    const artistBody = descriptionResult(artist.description, resultSeparator);
    const auditBody = descriptionResult(audit.description, resultSeparator);
    if (artistBody === undefined || auditBody === undefined
      || !artist.description.startsWith("# Task\n\n")
      || !artist.description.includes("\n\n# Symphony Metadata\n\n")
      || !audit.description.startsWith("# Task\n\n")
      || !audit.description.includes("\n\n# Symphony Metadata\n\n")
      || artist.comments.nodes.length !== 0 || audit.comments.nodes.length !== 0) {
      throw new Error("golden_result_comments_missing");
    }
    const cycleBodies = cycle.comments.nodes.map(({ body }) => body);
    const cycleTransition = cycleBodies.find((body) => body.startsWith("# Symphony Harness: Reconcile"));
    const cycleResult = cycleBodies.find((body) => body.startsWith("## Cycle Result"));
    const critiqueResultLink = cycleResult?.match(
      new RegExp(`- Critique: \\[cycle-${cycleTitle?.[1] ?? "000"}-critique-result\\.json\\]\\((https://[^)\\s]+)\\)`, "u"),
    );
    if (critiqueResultLink?.[1] !== undefined) critiqueResultUrls.push(critiqueResultLink[1]);
    if (cycleTransition === undefined || cycleResult === undefined
      || !validRootReconcileReport(cycleTransition, "cycle")
      || !(validArtistHumanReport(artistBody) || validArtistErrorReport(artistBody))
      || !validCriticMarkdown(auditBody)
      || cycleBodies.includes(auditBody)
      || !cycleResult.includes(`- Critic: [${audit.identifier}](${audit.url})`)
      || cycleResult.includes("Critic verdict")
      || cycleResult.includes("Reason:")
      || !cycleResult.includes(`- Critique: [cycle-${cycleTitle[1]}-critique-result.json](https://`)
      || cycleResult.includes("cycle-" + cycleTitle[1] + "-artist-result.md")
      || cycleResult.includes("cycle-" + cycleTitle[1] + "-critic-result.md")
      || cycleResult.includes("```json")
      || cycleBodies.some((body) => /(?:\.jsonl|\.stderr)/u.test(body))) {
      throw new Error("golden_result_comments_projection_invalid");
    }
  }
  if (critiqueResultUrls.length !== 1) throw new Error("golden_result_comments_file_link_invalid");
  validateArchitectureDecisionProjection(issue, scenario);
  return critiqueResultUrls[0];
}

function validCriticEnvelope(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!["accepted", "incomplete", "blocked", "violation", "process_error"].includes(value.verdict)) return false;
  if (value.verdict === "process_error") {
    return exactObject(value, ["verdict", "reason"])
      && typeof value.reason === "string" && value.reason.length > 0;
  }
  return exactObject(
    value,
    value.pending_finding === undefined
      ? ["verdict", "task_state_markdown"]
      : ["verdict", "task_state_markdown", "pending_finding"],
  ) && typeof value.task_state_markdown === "string" && value.task_state_markdown.length > 0
    && (value.pending_finding === undefined
      || (typeof value.pending_finding === "string" && value.pending_finding.length > 0));
}

function validCriticJson(value) {
  return exactObject(value, ["envelope", "report_markdown"])
    && validCriticEnvelope(value.envelope)
    && typeof value.report_markdown === "string"
    && value.report_markdown.length > 0;
}

export async function fetchGoldenCriticResult(url, token, fetchImpl = globalThis.fetch) {
  let parsedUrl;
  try {
    if (typeof url !== "string") throw new Error("invalid");
    parsedUrl = new URL(url);
  } catch {
    parsedUrl = undefined;
  }
  if (!(parsedUrl instanceof URL)
    || parsedUrl.protocol !== "https:"
    || parsedUrl.hostname !== "uploads.linear.app"
    || parsedUrl.port.length > 0
    || parsedUrl.username.length > 0
    || parsedUrl.password.length > 0
    || typeof token !== "string" || token.length === 0
    || typeof fetchImpl !== "function") {
    throw new Error("golden_critic_file_request_invalid");
  }
  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOLDEN_CRITIC_RESULT_TIMEOUT_MS);
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { Authorization: token, Accept: "application/json" },
    });
  } catch {
    throw new Error("golden_critic_file_fetch_failed");
  } finally {
    clearTimeout(timeout);
  }
  if (response?.ok !== true) throw new Error("golden_critic_file_http_failed");
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw new Error("golden_critic_file_content_type_invalid");
  }
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined
    && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_GOLDEN_CRITIC_RESULT_BYTES)) {
    throw new Error("golden_critic_file_too_large");
  }
  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new Error("golden_critic_file_read_failed");
  }
  if (bytes.byteLength > MAX_GOLDEN_CRITIC_RESULT_BYTES) {
    throw new Error("golden_critic_file_too_large");
  }
  let parsed;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(source);
  } catch {
    throw new Error("golden_critic_file_json_invalid");
  }
  if (!validCriticJson(parsed)) throw new Error("golden_critic_file_shape_invalid");
  return parsed;
}

async function verifyGoldenVisibleTree(token, rootId) {
  const data = await graphql(token, `query GoldenVisibleTree($id: String!) {
    issue(id: $id) {
      state { name type }
      children(first: 10) {
        nodes {
          title state { name type }
          children(first: 3) {
            nodes {
              title state { name type }
              children(first: 1) {
                nodes { title state { name type } }
                pageInfo { hasNextPage }
              }
            }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  }`, { id: rootId });
  validateGoldenVisibleTree(data.issue);
}

async function verifyGoldenResultComments(token, rootId, scenario) {
  const data = await graphql(token, `query GoldenResultComments($id: String!) {
    issue(id: $id) {
      description
      comments(first: 50) {
        nodes { body }
        pageInfo { hasNextPage }
      }
      children(first: 10) {
        nodes {
          title
          description
          comments(first: 20) {
            nodes { body }
            pageInfo { hasNextPage }
          }
          children(first: 3) {
            nodes {
              identifier title url
              description
              comments(first: 20) {
                nodes { body }
                pageInfo { hasNextPage }
              }
            }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage }
      }
    }
  }`, { id: rootId });
  const url = validateGoldenResultComments(data.issue, { scenario });
  await fetchGoldenCriticResult(url, token);
}

function githubEnvironment(environment, inherited) {
  return Object.fromEntries([
    "PATH", "HOME", "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "XDG_CONFIG_HOME",
  ].flatMap((key) => (environment[key] ?? inherited[key]) === undefined
    ? []
    : [[key, environment[key] ?? inherited[key]]]));
}

export async function cleanupGoldenRemote({
  pullRequestUrl,
  deliveryBranch,
  environment,
  inheritedEnvironment,
  executeCommand = execute,
} = {}) {
  const failures = [];
  const env = githubEnvironment(environment, inheritedEnvironment);
  if (pullRequestUrl !== undefined) {
    await executeCommand("gh", ["pr", "close", pullRequestUrl], {
      env, encoding: "utf8", timeout: 30_000,
    }).catch(() => failures.push("golden_pr_cleanup_failed"));
  }
  if (deliveryBranch !== undefined) {
    await executeCommand("git", ["push", "origin", "--delete", "--", deliveryBranch], {
      env, encoding: "utf8", timeout: 30_000,
    }).catch(() => failures.push("golden_branch_cleanup_failed"));
  }
  return failures;
}

export async function createGoldenFixture({
  scenario = "single-cycle",
  environment,
  inheritedEnvironment,
  diagnosticRoot,
} = {}) {
  const runId = crypto.randomUUID().slice(0, 8);
  const base = await mkdtemp(path.join(os.tmpdir(), "symphony-golden-"));
  const runDirectory = path.join(base, "run");
  const resolvedDiagnosticRoot = diagnosticRoot
    ?? environment?.SYMPHONY_E2E_DIAGNOSTIC_ROOT
    ?? environment?.SYMPHONY_E2E_DIAGNOSTIC_DIR;
  let root;
  try {
    await mkdir(runDirectory);
    root = await createLinearRoot(environment, runId, scenario);
  } catch (error) {
    await rm(base, { recursive: true, force: true });
    throw error instanceof Error && error.message.startsWith("golden_")
      ? error
      : new Error("golden_fixture_create_failed");
  }
  let humanReply;
  let rejectedReplies = [];
  let humanActionRequestId;
  const humanReplyBody = `I choose option ${GOLDEN_NEEDS_HUMAN_DEFAULT_OPTION}: create ${root.filename} with the exact bytes from the Root requirement.`;
  const rejectedReplyBodies = Object.freeze([
    "I reject both options for now; please provide more detail before I choose.",
    "I am not ready to select an option. Explain the trade-off first.",
  ]);

  return Object.freeze({
    root,
    runDirectory,
    workspace: path.join(base, "workspace"),
    async archiveFailure({ error, stdout, stderr } = {}) {
      return archiveGoldenFailure({
        archiveRoot: resolvedDiagnosticRoot,
        runDirectory,
        error,
        stdout,
        stderr,
      });
    },
    async verifyNeedsHumanBoundary() {
      if (!GOLDEN_HUMAN_ACTION_SCENARIOS.includes(scenario)) {
        throw new Error("golden_needs_human_unexpected");
      }
      const question = await verifyGoldenNeedsHumanQuestion(
        environment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN,
        root.id,
        [GOLDEN_NEEDS_HUMAN_DEFAULT_OPTION, GOLDEN_NEEDS_HUMAN_ALTERNATE_OPTION],
      );
      humanActionRequestId = question.request_comment_id;
    },
    async rejectNeedsHumanReplies() {
      if (scenario !== "human-action-rejected-supplement") {
        throw new Error("golden_needs_human_rejection_unexpected");
      }
      if (typeof humanActionRequestId !== "string" || rejectedReplies.length > 0) {
        throw new Error("golden_needs_human_rejection_request_invalid");
      }
      rejectedReplies = [];
      for (const body of rejectedReplyBodies) {
        rejectedReplies.push(await createGoldenHumanReply(
          environment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN,
          root.id,
          humanActionRequestId,
          body,
        ));
      }
      return Object.freeze(rejectedReplies.map(({ id }) => id));
    },
    async verifyRejectedNeedsHumanBoundary() {
      if (scenario !== "human-action-rejected-supplement" || rejectedReplies.length === 0) {
        throw new Error("golden_needs_human_rejection_missing");
      }
      await verifyGoldenNeedsHumanRejected(
        environment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN,
        root.id,
        rejectedReplies.map(({ id }) => id),
      );
    },
    async replyToNeedsHuman() {
      if (humanReply !== undefined) throw new Error("golden_needs_human_reply_duplicated");
      if (typeof humanActionRequestId !== "string") throw new Error("golden_needs_human_request_missing");
      humanReply = await createGoldenHumanReply(
        environment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN,
        root.id,
        humanActionRequestId,
        humanReplyBody,
      );
    },
    async verifyUnansweredNeedsHuman() {
      if (scenario !== "human-action-unanswered") {
        throw new Error("golden_needs_human_unanswered_unexpected");
      }
      await verifyGoldenNeedsHumanUnanswered(
        environment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN,
        root.id,
      );
    },
    async verifyVisibleCompletion() {
      if (scenario === "human-action-unanswered") {
        await this.verifyUnansweredNeedsHuman();
        return;
      }
      await verifyGoldenVisibleTree(environment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN, root.id);
      await verifyGoldenResultComments(environment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN, root.id, scenario);
      if (scenario === "human-action-rejected-supplement") {
        if (humanReply === undefined || rejectedReplies.length === 0) {
          throw new Error("golden_needs_human_supplement_missing");
        }
        await verifyGoldenNeedsHumanSupplement(
          environment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN,
          root.id,
          humanReply.id,
        );
      } else if (scenario === "single-cycle-human-action" || scenario === "cycle-human-action-cycle") {
        if (humanReply === undefined) throw new Error("golden_needs_human_reply_missing");
        await verifyGoldenNeedsHumanAcceptance(
          environment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN,
          root.id,
          humanReply.id,
          humanReplyBody,
        );
      }
    },
    async cleanup(pullRequestUrl, {
      archiveIssueTree: shouldArchiveIssueTree = false,
      deliveryBranch,
    } = {}) {
      const failures = await cleanupGoldenRemote({
        pullRequestUrl, deliveryBranch, environment, inheritedEnvironment,
      });
      if (shouldArchiveIssueTree) {
        await archiveIssueTree(environment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN, root.id)
          .catch(() => failures.push("golden_issue_cleanup_failed"));
      }
      await rm(base, { recursive: true, force: true })
        .catch(() => failures.push("golden_workspace_cleanup_failed"));
      if (failures.length > 0) throw new Error(failures[0]);
    },
  });
}
