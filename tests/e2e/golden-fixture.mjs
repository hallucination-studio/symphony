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

async function graphql(token, query, variables) {
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("golden_linear_request_failed");
  }
  if (!response.ok) throw new Error("golden_linear_request_failed");
  const envelope = await response.json().catch(() => null);
  if (envelope === null || typeof envelope !== "object" || !envelope.data || envelope.errors?.length) {
    throw new Error("golden_linear_response_invalid");
  }
  return envelope.data;
}

export async function createLinearRoot(environment, runId) {
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
  const created = await graphql(token, `mutation GoldenRoot($input: IssueCreateInput!) {
    issueCreate(input: $input) { success issue { id identifier url } }
  }`, {
    input: {
      teamId,
      projectId: project.id,
      stateId,
      title: `[E2E] Symphony golden Root ${runId}`,
      description: [
        `Create ${filename} containing exactly: Symphony golden E2E ${runId}`,
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

export function validateGoldenResultComments(issue) {
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
    || issue.comments.nodes.some(({ body }) => body.startsWith("# Symphony Harness:"))) {
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

async function verifyGoldenResultComments(token, rootId) {
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
  const url = validateGoldenResultComments(data.issue);
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
    root = await createLinearRoot(environment, runId);
  } catch (error) {
    await rm(base, { recursive: true, force: true });
    throw error instanceof Error && error.message.startsWith("golden_")
      ? error
      : new Error("golden_fixture_create_failed");
  }

  return Object.freeze({
    root,
    runDirectory,
    async archiveFailure({ error, stdout, stderr } = {}) {
      return archiveGoldenFailure({
        archiveRoot: resolvedDiagnosticRoot,
        runDirectory,
        error,
        stdout,
        stderr,
      });
    },
    async verifyVisibleCompletion() {
      await verifyGoldenVisibleTree(environment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN, root.id);
      await verifyGoldenResultComments(environment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN, root.id);
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
