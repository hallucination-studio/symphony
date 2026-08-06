import {
  asRecord,
  freezeObject,
  parseAbsolutePath,
  parseBoundedString,
} from "./validation.js";

export interface RootWorkspace {
  readonly workspace_path: string;
  readonly run_directory: string;
  readonly root_branch: string;
}

export type Delivery =
  | { readonly kind: "pull_request"; readonly url: string; readonly branch: string }
  | { readonly kind: "branch"; readonly branch: string; readonly remote?: string | undefined }
  | { readonly kind: "files"; readonly workspace_path: string; readonly files: readonly string[] };

export function parseDelivery(value: unknown): Delivery {
  const record = asRecord(value, "invalid_delivery");
  if (record.kind === "pull_request") {
    if (Object.keys(record).sort().join("\0") !== ["branch", "kind", "url"].sort().join("\0")) throw new Error("invalid_contract_keys");
    const url = parseBoundedString(record.url, "invalid_delivery_url", 2_048);
    if (!URL.canParse(url)) throw new Error("invalid_delivery_url");
    return freezeObject({ kind: record.kind, url, branch: parseBoundedString(record.branch, "invalid_delivery_branch", 256) });
  }
  if (record.kind === "branch") {
    if (Object.keys(record).some((key) => !["branch", "kind", "remote"].includes(key))) throw new Error("invalid_contract_keys");
    const remote = record.remote === undefined ? undefined : parseBoundedString(record.remote, "invalid_delivery_remote", 256);
    return freezeObject({ kind: record.kind, branch: parseBoundedString(record.branch, "invalid_delivery_branch", 256), ...(remote === undefined ? {} : { remote }) });
  }
  if (record.kind === "files") {
    if (Object.keys(record).sort().join("\0") !== ["files", "kind", "workspace_path"].sort().join("\0")) throw new Error("invalid_contract_keys");
    if (!Array.isArray(record.files) || record.files.length === 0 || record.files.length > 10_000) throw new Error("invalid_delivery_files");
    const files = record.files.map((entry) => {
      const file = parseBoundedString(entry, "invalid_delivery_file", 2_048).replaceAll("\\", "/");
      if (file.startsWith("/") || file.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error("invalid_delivery_file");
      return file;
    });
    if (new Set(files).size !== files.length) throw new Error("invalid_delivery_files");
    return freezeObject({ kind: record.kind, workspace_path: parseAbsolutePath(record.workspace_path, "invalid_delivery_workspace_path"), files: Object.freeze(files) });
  }
  throw new Error("invalid_contract_variant");
}

export function parseRootWorkspace(value: unknown): RootWorkspace {
  const record = asRecord(value, "invalid_root_workspace");
  if (Object.keys(record).sort().join("\0") !== ["root_branch", "run_directory", "workspace_path"].sort().join("\0")) {
    throw new Error("invalid_contract_keys");
  }
  return freezeObject({
    workspace_path: parseAbsolutePath(record.workspace_path, "invalid_workspace_path"),
    run_directory: parseAbsolutePath(record.run_directory, "invalid_run_directory"),
    root_branch: parseBoundedString(record.root_branch, "invalid_root_branch", 256),
  });
}
