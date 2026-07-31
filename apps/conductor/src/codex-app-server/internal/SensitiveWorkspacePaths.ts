import { lstat, opendir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_SCANNED_WORKSPACE_ENTRIES = 200_000;
const MAX_SCANNED_WORKSPACE_PATH_BYTES = 32 * 1024 * 1024;
const MAX_DENIED_WORKSPACE_PATHS = 256;
const MAX_DENIED_WORKSPACE_PATH_BYTES = 32 * 1024;
const MAX_WORKSPACE_PATH_LENGTH = 4_096;

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

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function isSensitiveWorkspacePath(relativePath: string): boolean {
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

export function snapshotDeniedWorkspacePaths(
  workspaceRoot: string,
  value: readonly string[] | undefined,
): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_DENIED_WORKSPACE_PATHS) {
    throw new Error("invalid_codex_local_only_denied_path");
  }
  const denied = new Set<string>();
  let encodedBytes = 0;
  for (const entry of value) {
    if (
      typeof entry !== "string"
      || entry.length === 0
      || entry.length > MAX_WORKSPACE_PATH_LENGTH
      || entry.includes("\0")
      || !path.isAbsolute(entry)
    ) throw new Error("invalid_codex_local_only_denied_path");
    const normalized = path.normalize(entry);
    if (normalized !== entry || normalized === workspaceRoot || !inside(workspaceRoot, normalized)) {
      throw new Error("invalid_codex_local_only_denied_path");
    }
    if (denied.has(normalized)) continue;
    denied.add(normalized);
    encodedBytes += Buffer.byteLength(normalized, "utf8");
    if (encodedBytes > MAX_DENIED_WORKSPACE_PATH_BYTES) {
      throw new Error("invalid_codex_local_only_denied_path");
    }
  }
  return Object.freeze([...denied].sort());
}

export async function scanSensitiveWorkspacePaths(workspaceRootValue: string): Promise<readonly string[]> {
  try {
    const workspaceRoot = path.normalize(workspaceRootValue);
    if (
      !path.isAbsolute(workspaceRoot)
      || workspaceRoot !== workspaceRootValue
      || workspaceRoot === path.parse(workspaceRoot).root
      || workspaceRoot === path.normalize(os.homedir())
    ) {
      throw new Error("invalid_sensitive_workspace");
    }
    const [canonicalRoot, rootInfo] = await Promise.all([
      realpath(workspaceRoot),
      lstat(workspaceRoot),
    ]);
    if (
      path.normalize(canonicalRoot) !== workspaceRoot
      || rootInfo.isSymbolicLink()
      || !rootInfo.isDirectory()
    ) throw new Error("invalid_sensitive_workspace");

    const pending = ["."];
    const denied: string[] = [];
    let scannedEntries = 0;
    let scannedPathBytes = 0;
    let deniedPathBytes = 0;
    while (pending.length > 0) {
      const relativeDirectory = pending.shift();
      if (relativeDirectory === undefined) break;
      const directoryPath = relativeDirectory === "."
        ? workspaceRoot
        : path.join(workspaceRoot, ...relativeDirectory.split("/"));
      const [canonicalDirectory, directoryInfo] = await Promise.all([
        realpath(directoryPath),
        lstat(directoryPath),
      ]);
      if (
        path.normalize(canonicalDirectory) !== directoryPath
        || !inside(workspaceRoot, canonicalDirectory)
        || directoryInfo.isSymbolicLink()
        || !directoryInfo.isDirectory()
      ) throw new Error("invalid_sensitive_workspace");

      const directory = await opendir(directoryPath);
      try {
        for (;;) {
          const entry = await directory.read();
          if (entry === null) break;
          scannedEntries += 1;
          if (scannedEntries > MAX_SCANNED_WORKSPACE_ENTRIES) {
            throw new Error("sensitive_workspace_scan_limit");
          }
          const relativePath = relativeDirectory === "."
            ? entry.name
            : `${relativeDirectory}/${entry.name}`;
          scannedPathBytes += Buffer.byteLength(relativePath, "utf8");
          if (scannedPathBytes > MAX_SCANNED_WORKSPACE_PATH_BYTES) {
            throw new Error("sensitive_workspace_scan_limit");
          }
          if (isSensitiveWorkspacePath(relativePath)) {
            const deniedPath = path.join(workspaceRoot, ...relativePath.split("/"));
            deniedPathBytes += Buffer.byteLength(deniedPath, "utf8");
            if (
              denied.length >= MAX_DENIED_WORKSPACE_PATHS
              || deniedPath.length > MAX_WORKSPACE_PATH_LENGTH
              || deniedPathBytes > MAX_DENIED_WORKSPACE_PATH_BYTES
            ) throw new Error("sensitive_workspace_scan_limit");
            denied.push(deniedPath);
            continue;
          }
          if (entry.isDirectory()) pending.push(relativePath);
        }
      } finally {
        await directory.close();
      }
      const [finalCanonical, finalInfo] = await Promise.all([
        realpath(directoryPath),
        lstat(directoryPath),
      ]);
      if (
        path.normalize(finalCanonical) !== directoryPath
        || finalInfo.isSymbolicLink()
        || !finalInfo.isDirectory()
      ) throw new Error("invalid_sensitive_workspace");
    }
    return snapshotDeniedWorkspacePaths(workspaceRoot, denied);
  } catch {
    throw new Error("sensitive_workspace_scan_failed");
  }
}
