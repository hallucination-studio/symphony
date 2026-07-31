import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseCorrelationId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseSchemaVersion,
  type CorrelationId,
} from "../../contracts/identity.js";
import type { RuntimeTarget } from "../../contracts/runtime.js";
import {
  asRecord,
  assertExactKeys,
  containsCredentialMaterial,
  parseBoundedString,
} from "../../contracts/validation.js";
import {
  RootToolCallError,
  RootToolFatalError,
  type RootToolBinding,
  type RootToolExecution,
  type RootToolSpec,
} from "../../runtime/RootToolBoundary.js";

export const ROOT_CODE_INSPECTION_CAPABILITIES = Object.freeze({
  list_code_directory: "code_inspection:list_directory",
  read_code_file: "code_inspection:read_file",
  search_code: "code_inspection:search",
} as const);

type RootCodeInspectionTool = keyof typeof ROOT_CODE_INSPECTION_CAPABILITIES;

const MAX_CODE_PATH_LENGTH = 2_048;
const CODE_DIRECTORY_PAGE_SIZE = 128;
const MAX_READ_LINES = 200;
const MAX_READ_FILE_BYTES = 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 1_024;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILES = 10_000;
const MAX_SEARCH_DIRECTORIES = 512;
const MAX_SEARCH_ENTRIES = 20_000;
const MAX_SEARCH_BYTES = 32 * 1024 * 1024;
const MAX_SEARCH_MATCH_CHARACTERS = 4_096;
const SENSITIVE_LINE = "[sensitive line omitted]";

const PRIVATE_KEY_MATERIAL = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u,
  /-----BEGIN PGP PRIVATE KEY BLOCK-----/u,
  /---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----/u,
  /\bAGE-SECRET-KEY-[A-Z0-9]+\b/u,
  /PuTTY-User-Key-File-[0-9]+\s*:/u,
] as const;

const SENSITIVE_SEGMENTS = new Set([
  ".aws",
  ".azure",
  ".docker",
  ".git",
  ".gnupg",
  ".kube",
  ".ssh",
  ".terraform.d",
]);

const SENSITIVE_BASENAMES = new Set([
  ".git-credentials",
  ".gitconfig",
  ".gitmodules",
  ".lfsconfig",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".terraformrc",
  ".yarnrc",
  ".yarnrc.yml",
  "auth.json",
  "application_default_credentials.json",
  "credentials",
  "credentials.json",
  "credentials.toml",
  "credentials.yaml",
  "credentials.yml",
]);

const SENSITIVE_EXTENSIONS = new Set([
  ".jks",
  ".key",
  ".keystore",
  ".p12",
  ".pem",
  ".pfx",
  ".pk8",
  ".ppk",
]);

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: Object.freeze(properties),
    required: Object.freeze(Object.keys(properties)),
  });
}

function commonProperties(target: RuntimeTarget, capability: string): Record<string, unknown> {
  return {
    schema_version: Object.freeze({ const: 1 }),
    root_id: Object.freeze({ const: target.root_id }),
    runtime_generation: Object.freeze({ const: target.runtime_generation }),
    correlation_id: Object.freeze({
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    }),
    capability: Object.freeze({ const: capability }),
  };
}

function specs(target: RuntimeTarget): readonly RootToolSpec[] {
  const codePath = Object.freeze({
    type: "string",
    minLength: 1,
    maxLength: MAX_CODE_PATH_LENGTH,
    pattern: "^[^\\\\\\r\\n\\u0000]+$",
  });
  return deepFreeze([
    {
      type: "function" as const,
      name: "list_code_directory",
      description: "List one non-sensitive code directory with bounded cursor pagination",
      inputSchema: objectSchema({
        ...commonProperties(target, ROOT_CODE_INSPECTION_CAPABILITIES.list_code_directory),
        path: codePath,
        cursor: Object.freeze({
          anyOf: Object.freeze([
            Object.freeze({ type: "string", minLength: 1, maxLength: 255 }),
            Object.freeze({ type: "null" }),
          ]),
        }),
        page_size: Object.freeze({ const: CODE_DIRECTORY_PAGE_SIZE }),
      }),
    },
    {
      type: "function" as const,
      name: "read_code_file",
      description: "Read a bounded line window from one non-sensitive code file",
      inputSchema: objectSchema({
        ...commonProperties(target, ROOT_CODE_INSPECTION_CAPABILITIES.read_code_file),
        path: codePath,
        start_line: Object.freeze({ type: "integer", minimum: 1 }),
        max_lines: Object.freeze({ type: "integer", minimum: 1, maximum: MAX_READ_LINES }),
      }),
    },
    {
      type: "function" as const,
      name: "search_code",
      description: "Search non-sensitive code text under one directory with bounded results",
      inputSchema: objectSchema({
        ...commonProperties(target, ROOT_CODE_INSPECTION_CAPABILITIES.search_code),
        path: codePath,
        query: Object.freeze({ type: "string", minLength: 1, maxLength: 256 }),
        max_results: Object.freeze({ type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS }),
      }),
    },
  ]);
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function compareCodeNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSensitivePath(relativePath: string): boolean {
  const segments = relativePath.split("/").map((segment) => segment.toLowerCase());
  if (segments.some((segment) => segment.startsWith(".env") || SENSITIVE_SEGMENTS.has(segment))) {
    return true;
  }
  const basename = segments.at(-1) ?? "";
  if (
    SENSITIVE_BASENAMES.has(basename)
    || SENSITIVE_EXTENSIONS.has(basename)
    || SENSITIVE_EXTENSIONS.has(path.posix.extname(basename))
    || /^id_(?:dsa|ecdsa|ed25519|rsa)(?:\.|$)/u.test(basename)
  ) return true;
  return segments.some((segment, index) => (
    segment === ".config"
    && ["gcloud", "gh", "git", "glab-cli", "hub", "op"].includes(segments[index + 1] ?? "")
  ));
}

function codePath(value: unknown): string {
  const parsed = parseBoundedString(value, "invalid_code_path", MAX_CODE_PATH_LENGTH);
  if (parsed === ".") return parsed;
  if (
    path.posix.isAbsolute(parsed)
    || parsed.includes("\\")
    || parsed.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) throw new RootToolCallError("capability_denied");
  const normalized = path.posix.normalize(parsed);
  if (normalized !== parsed || isSensitivePath(normalized)) {
    throw new RootToolCallError("capability_denied");
  }
  return normalized;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error("invalid_code_inspection_integer");
  }
  return value as number;
}

function containsPrivateKey(value: string): boolean {
  return PRIVATE_KEY_MATERIAL.some((pattern) => pattern.test(value));
}

function redactLine(value: string): string {
  return containsCredentialMaterial(value) ? SENSITIVE_LINE : value;
}

function searchMatchText(value: string, query: string): string {
  const redacted = redactLine(value);
  if (redacted === SENSITIVE_LINE || redacted.length <= MAX_SEARCH_MATCH_CHARACTERS) return redacted;
  const matchIndex = value.indexOf(query);
  const radius = Math.max(0, Math.floor(
    (MAX_SEARCH_MATCH_CHARACTERS - query.length - 6) / 2,
  ));
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(value.length, matchIndex + query.length + radius);
  return `${start > 0 ? "..." : ""}${value.slice(start, end)}${end < value.length ? "..." : ""}`;
}

function callError(error: unknown): RootToolCallError | RootToolFatalError {
  if (error instanceof RootToolCallError || error instanceof RootToolFatalError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "ELOOP" || code === "EPERM") {
    return new RootToolCallError("capability_denied");
  }
  if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
    return new RootToolCallError("invalid_contract");
  }
  if (error instanceof Error && error.message.startsWith("invalid_")) {
    return new RootToolCallError("invalid_contract");
  }
  return new RootToolFatalError("boundary_unavailable");
}

function parseEnvelope(
  value: unknown,
  expected: RuntimeTarget,
  correlationId: CorrelationId,
  tool: RootCodeInspectionTool,
  fields: readonly string[],
): Record<string, unknown> {
  try {
    const record = asRecord(value);
    assertExactKeys(record, [
      "schema_version",
      "root_id",
      "runtime_generation",
      "correlation_id",
      "capability",
      ...fields,
    ]);
    parseSchemaVersion(record.schema_version);
    if (parseRootIssueId(record.root_id) !== expected.root_id) throw new Error("invalid_root_identity");
    if (parseRuntimeGeneration(record.runtime_generation) !== expected.runtime_generation) {
      throw new RootToolCallError("stale_generation");
    }
    if (parseCorrelationId(record.correlation_id) !== correlationId) {
      throw new Error("invalid_correlation_identity");
    }
    if (record.capability !== ROOT_CODE_INSPECTION_CAPABILITIES[tool]) {
      throw new RootToolCallError("capability_denied");
    }
    return record;
  } catch (error) {
    throw callError(error);
  }
}

interface OpenedCodeFile {
  readonly relativePath: string;
  readonly text: string;
  readonly bytes: number;
}

type RootCodeInspectionBinder = (correlationId: CorrelationId) => readonly RootToolBinding[];
const ROOT_CODE_INSPECTION_BINDERS = new WeakMap<object, RootCodeInspectionBinder>();

export class RootCodeInspection {
  readonly target: RuntimeTarget;
  readonly workspaceRoot: string;
  readonly specs: readonly RootToolSpec[];

  private constructor(target: RuntimeTarget, workspaceRoot: string) {
    this.target = target;
    this.workspaceRoot = workspaceRoot;
    this.specs = specs(target);
    ROOT_CODE_INSPECTION_BINDERS.set(this, (correlationId) => this.#bindings(correlationId));
    Object.freeze(this);
  }

  static async create(options: {
    readonly target: RuntimeTarget;
    readonly workspaceRoot: string;
  }): Promise<RootCodeInspection> {
    try {
      if (!path.isAbsolute(options.workspaceRoot) || options.workspaceRoot.includes("\0")) {
        throw new Error("invalid_root_workspace");
      }
      const requested = path.normalize(options.workspaceRoot);
      const canonical = path.normalize(await realpath(requested));
      const info = await lstat(canonical);
      if (
        requested !== canonical
        || !info.isDirectory()
        || canonical === path.parse(canonical).root
        || canonical === path.normalize(os.homedir())
      ) throw new Error("invalid_root_workspace");
      const target = Object.freeze({
        root_id: parseRootIssueId(options.target.root_id),
        runtime_generation: parseRuntimeGeneration(options.target.runtime_generation),
      });
      return new RootCodeInspection(target, canonical);
    } catch {
      throw new Error("invalid_root_workspace");
    }
  }

  #bindings(correlationId: CorrelationId): readonly RootToolBinding[] {
    const currentCorrelation = parseCorrelationId(correlationId);
    return Object.freeze(this.specs.map((spec): RootToolBinding => Object.freeze({
      spec,
      execute: (value: unknown, execution: RootToolExecution) =>
        this.#execute(spec.name as RootCodeInspectionTool, value, currentCorrelation, execution),
    })));
  }

  async #execute(
    tool: RootCodeInspectionTool,
    value: unknown,
    correlationId: CorrelationId,
    execution: RootToolExecution,
  ): Promise<unknown> {
    execution.assertActive();
    try {
      switch (tool) {
        case "list_code_directory": return await this.#list(value, correlationId, execution);
        case "read_code_file": return await this.#read(value, correlationId, execution);
        case "search_code": return await this.#search(value, correlationId, execution);
      }
    } catch (error) {
      throw callError(error);
    }
  }

  async #list(
    value: unknown,
    correlationId: CorrelationId,
    execution: RootToolExecution,
  ): Promise<unknown> {
    const call = parseEnvelope(
      value,
      this.target,
      correlationId,
      "list_code_directory",
      ["path", "cursor", "page_size"],
    );
    const relativePath = codePath(call.path);
    const cursor = call.cursor === null
      ? null
      : parseBoundedString(call.cursor, "invalid_code_cursor", 255);
    if (call.page_size !== CODE_DIRECTORY_PAGE_SIZE) throw new Error("invalid_code_page_size");
    const entries = await this.#directoryEntries(relativePath);
    execution.assertActive();
    const remaining = cursor === null
      ? entries
      : entries.filter(({ name }) => compareCodeNames(name, cursor) > 0);
    const page = remaining.slice(0, CODE_DIRECTORY_PAGE_SIZE);
    return Object.freeze({
      schema_version: 1,
      root_id: this.target.root_id,
      runtime_generation: this.target.runtime_generation,
      correlation_id: correlationId,
      operation: "list_code_directory",
      path: relativePath,
      entries: Object.freeze(page),
      next_cursor: remaining.length > page.length ? page.at(-1)?.name ?? null : null,
    });
  }

  async #read(
    value: unknown,
    correlationId: CorrelationId,
    execution: RootToolExecution,
  ): Promise<unknown> {
    const call = parseEnvelope(
      value,
      this.target,
      correlationId,
      "read_code_file",
      ["path", "start_line", "max_lines"],
    );
    const relativePath = codePath(call.path);
    if (relativePath === ".") throw new Error("invalid_code_file");
    const startLine = integer(call.start_line, 1, Number.MAX_SAFE_INTEGER);
    const maxLines = integer(call.max_lines, 1, MAX_READ_LINES);
    const file = await this.#openCodeFile(relativePath);
    execution.assertActive();
    const lines = file.text.split("\n");
    const hasFinalNewline = lines.at(-1) === "";
    if (hasFinalNewline) lines.pop();
    const totalLines = lines.length;
    const firstIndex = Math.min(startLine - 1, totalLines);
    const selected = lines.slice(firstIndex, firstIndex + maxLines).map(redactLine);
    const endLine = selected.length === 0 ? startLine - 1 : startLine + selected.length - 1;
    let content = selected.join("\n");
    if (selected.length > 0 && (endLine < totalLines || (hasFinalNewline && endLine === totalLines))) {
      content += "\n";
    }
    return Object.freeze({
      schema_version: 1,
      root_id: this.target.root_id,
      runtime_generation: this.target.runtime_generation,
      correlation_id: correlationId,
      operation: "read_code_file",
      path: relativePath,
      start_line: startLine,
      end_line: endLine,
      total_lines: totalLines,
      content,
      truncated: startLine > 1 || endLine < totalLines,
    });
  }

  async #search(
    value: unknown,
    correlationId: CorrelationId,
    execution: RootToolExecution,
  ): Promise<unknown> {
    const call = parseEnvelope(
      value,
      this.target,
      correlationId,
      "search_code",
      ["path", "query", "max_results"],
    );
    const relativePath = codePath(call.path);
    const query = parseBoundedString(call.query, "invalid_code_query", 256);
    const maxResults = integer(call.max_results, 1, MAX_SEARCH_RESULTS);
    const pending = [relativePath];
    const matches: { readonly path: string; readonly line: number; readonly text: string }[] = [];
    let scannedFiles = 0;
    let scannedDirectories = 0;
    let scannedEntries = 0;
    let scannedBytes = 0;
    let truncated = false;
    while (pending.length > 0) {
      execution.assertActive();
      if (scannedDirectories >= MAX_SEARCH_DIRECTORIES) {
        truncated = true;
        break;
      }
      const directory = pending.shift();
      if (directory === undefined) break;
      scannedDirectories += 1;
      const entries = await this.#directoryEntries(directory);
      for (const entry of entries) {
        execution.assertActive();
        if (scannedEntries >= MAX_SEARCH_ENTRIES) {
          truncated = true;
          pending.length = 0;
          break;
        }
        scannedEntries += 1;
        if (entry.kind === "directory") {
          pending.push(entry.path);
          continue;
        }
        if (scannedFiles >= MAX_SEARCH_FILES || scannedBytes >= MAX_SEARCH_BYTES) {
          truncated = true;
          pending.length = 0;
          break;
        }
        scannedFiles += 1;
        let file: OpenedCodeFile;
        try {
          file = await this.#openCodeFile(entry.path);
        } catch (error) {
          if (error instanceof RootToolCallError) continue;
          throw error;
        }
        if (scannedBytes + file.bytes > MAX_SEARCH_BYTES) {
          truncated = true;
          pending.length = 0;
          break;
        }
        scannedBytes += file.bytes;
        const lines = file.text.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (!line.includes(query)) continue;
          matches.push(Object.freeze({
            path: file.relativePath,
            line: index + 1,
            text: searchMatchText(line, query),
          }));
          if (matches.length >= maxResults) {
            truncated = true;
            pending.length = 0;
            break;
          }
        }
        if (truncated && matches.length >= maxResults) break;
      }
    }
    return Object.freeze({
      schema_version: 1,
      root_id: this.target.root_id,
      runtime_generation: this.target.runtime_generation,
      correlation_id: correlationId,
      operation: "search_code",
      path: relativePath,
      query,
      matches: Object.freeze(matches),
      truncated,
    });
  }

  async #directoryEntries(relativePath: string): Promise<readonly {
    readonly name: string;
    readonly path: string;
    readonly kind: "directory" | "file";
  }[]> {
    const candidate = this.#candidate(relativePath);
    const canonical = path.normalize(await realpath(candidate));
    const info = await lstat(candidate);
    if (!inside(this.workspaceRoot, canonical) || info.isSymbolicLink() || !info.isDirectory()) {
      throw new RootToolCallError("capability_denied");
    }
    const current = path.normalize(await realpath(candidate));
    if (current !== canonical) throw new RootToolCallError("capability_denied");
    const directory = await opendir(canonical);
    const entries: {
      readonly name: string;
      readonly path: string;
      readonly kind: "directory" | "file";
    }[] = [];
    let scannedEntries = 0;
    try {
      for (;;) {
        const entry = await directory.read();
        if (entry === null) break;
        scannedEntries += 1;
        if (scannedEntries > MAX_DIRECTORY_ENTRIES) {
          throw new RootToolCallError("invalid_contract");
        }
        const childPath = relativePath === "." ? entry.name : `${relativePath}/${entry.name}`;
        if (
          entry.isSymbolicLink()
          || isSensitivePath(childPath)
          || (!entry.isDirectory() && !entry.isFile())
        ) continue;
        entries.push(Object.freeze({
          name: entry.name,
          path: childPath,
          kind: entry.isDirectory() ? "directory" as const : "file" as const,
        }));
      }
    } finally {
      await directory.close();
    }
    const [finalCanonical, finalInfo] = await Promise.all([
      realpath(candidate).then((value) => path.normalize(value)),
      lstat(candidate),
    ]);
    if (
      finalCanonical !== canonical
      || finalInfo.isSymbolicLink()
      || !finalInfo.isDirectory()
      || finalInfo.dev !== info.dev
      || finalInfo.ino !== info.ino
    ) throw new RootToolCallError("capability_denied");
    return Object.freeze(entries.sort((left, right) => compareCodeNames(left.name, right.name)));
  }

  async #openCodeFile(relativePath: string): Promise<OpenedCodeFile> {
    const candidate = this.#candidate(relativePath);
    const canonical = path.normalize(await realpath(candidate));
    const linkInfo = await lstat(candidate);
    if (!inside(this.workspaceRoot, canonical) || linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
      throw new RootToolCallError("capability_denied");
    }
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const [handleInfo, currentCanonical] = await Promise.all([
        handle.stat(),
        realpath(candidate).then((value) => path.normalize(value)),
      ]);
      if (
        currentCanonical !== canonical
        || !handleInfo.isFile()
        || handleInfo.dev !== linkInfo.dev
        || handleInfo.ino !== linkInfo.ino
      ) throw new RootToolCallError("capability_denied");
      const buffer = Buffer.alloc(MAX_READ_FILE_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > MAX_READ_FILE_BYTES) throw new RootToolCallError("invalid_contract");
      const bytes = buffer.subarray(0, offset);
      if (bytes.includes(0)) throw new RootToolCallError("capability_denied");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new RootToolCallError("capability_denied");
      }
      if (/[^\t\n\r\u0020-\uFFFF]/u.test(text) || containsPrivateKey(text)) {
        throw new RootToolCallError("capability_denied");
      }
      return Object.freeze({ relativePath, text, bytes: offset });
    } finally {
      await handle.close();
    }
  }

  #candidate(relativePath: string): string {
    const candidate = relativePath === "."
      ? this.workspaceRoot
      : path.join(this.workspaceRoot, ...relativePath.split("/"));
    if (!inside(this.workspaceRoot, candidate)) throw new RootToolCallError("capability_denied");
    return candidate;
  }
}

export function isRootCodeInspection(value: unknown): value is RootCodeInspection {
  return typeof value === "object"
    && value !== null
    && Object.getPrototypeOf(value) === RootCodeInspection.prototype
    && Object.isFrozen(value)
    && ROOT_CODE_INSPECTION_BINDERS.has(value);
}

export function bindRootCodeInspection(
  inspection: RootCodeInspection,
  correlationId: CorrelationId,
): readonly RootToolBinding[] {
  if (!isRootCodeInspection(inspection)) throw new Error("unbound_root_code_inspection");
  const binder = ROOT_CODE_INSPECTION_BINDERS.get(inspection);
  if (binder === undefined) throw new Error("unbound_root_code_inspection");
  return binder(correlationId);
}
