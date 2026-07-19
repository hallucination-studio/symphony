import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentExecutionPolicy,
  PerformerProfile,
  PerformerProfileStoreInterface,
} from "../api/PerformerProfileStoreInterface.js";

interface ProfileFile {
  profiles: PerformerProfile[];
  activeProfileId?: string;
}

export class FilePerformerProfileStoreImpl
  implements PerformerProfileStoreInterface
{
  readonly #directory: string;
  readonly #filePath: string;

  constructor(dataRoot: string) {
    this.#directory = path.join(dataRoot, "performer-profiles");
    this.#filePath = path.join(this.#directory, "profiles.json");
  }

  async list(): Promise<ProfileFile> {
    try {
      return validateFile(JSON.parse(await readFile(this.#filePath, "utf8")));
    } catch (error) {
      if (isMissing(error)) return { profiles: [] };
      throw error;
    }
  }

  async create(input: {
    profileId: string;
    displayName: string;
    backendKind: "codex";
    authenticationMethod: "chatgpt" | "api_key";
    codexTurnSettings: PerformerProfile["codexTurnSettings"];
    executionPolicy?: AgentExecutionPolicy;
    now: string;
  }) {
    validateSettings(input.authenticationMethod, input.codexTurnSettings);
    const executionPolicy = input.executionPolicy ?? defaultExecutionPolicy();
    validateExecutionPolicy(executionPolicy);
    const file = await this.list();
    if (file.profiles.some((profile) => profile.profileId === input.profileId)) {
      throw new Error("profile_already_exists");
    }
    const profile: PerformerProfile = {
      profileId: input.profileId,
      displayName: requireText(input.displayName),
      backendKind: "codex",
      authenticationMethod: input.authenticationMethod,
      codexTurnSettings: input.codexTurnSettings,
      executionPolicy,
      createdAt: input.now,
      updatedAt: input.now,
    };
    await mkdir(this.codexHome(profile.profileId), { recursive: true, mode: 0o700 });
    await chmod(this.codexHome(profile.profileId), 0o700);
    await this.#write({ ...file, profiles: [...file.profiles, profile] });
    return profile;
  }

  async update(input: {
    profileId: string;
    displayName: string;
    codexTurnSettings: PerformerProfile["codexTurnSettings"];
    executionPolicy?: AgentExecutionPolicy;
    now: string;
  }) {
    const file = await this.list();
    const existing = file.profiles.find(
      (profile) => profile.profileId === input.profileId,
    );
    if (!existing) throw new Error("profile_not_found");
    validateSettings(existing.authenticationMethod, input.codexTurnSettings);
    const executionPolicy = input.executionPolicy ?? existing.executionPolicy;
    validateExecutionPolicy(executionPolicy);
    const updated: PerformerProfile = {
      ...existing,
      displayName: requireText(input.displayName),
      codexTurnSettings: input.codexTurnSettings,
      executionPolicy,
      updatedAt: input.now,
    };
    await this.#write({
      ...file,
      profiles: file.profiles.map((profile) =>
        profile.profileId === updated.profileId ? updated : profile,
      ),
    });
    return updated;
  }

  async activate(
    profileId: string,
    readiness: "login-required" | "ready" | "invalid",
  ) {
    if (readiness !== "ready") throw new Error("profile_not_ready");
    const file = await this.list();
    if (!file.profiles.some((profile) => profile.profileId === profileId)) {
      throw new Error("profile_not_found");
    }
    await this.#write({ ...file, activeProfileId: profileId });
  }

  codexHome(profileId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(profileId)) {
      throw new Error("profile_id_invalid");
    }
    return path.join(this.#directory, profileId, "codex-home");
  }

  async #write(file: ProfileFile) {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.#filePath);
    await chmod(this.#filePath, 0o600);
  }
}

function validateSettings(
  authenticationMethod: PerformerProfile["authenticationMethod"],
  settings: PerformerProfile["codexTurnSettings"],
) {
  requireText(settings.model);
  if (
    !["none", "minimal", "low", "medium", "high", "xhigh"].includes(
      settings.reasoningEffort,
    )
  ) {
    throw new Error("reasoning_effort_invalid");
  }
  if (authenticationMethod === "api_key" && settings.isFastModeEnabled) {
    throw new Error("api_key_fast_unavailable");
  }
}

function validateFile(value: unknown): ProfileFile {
  if (!isRecord(value) || !hasOnlyKeys(value, ["profiles", "activeProfileId"])) {
    throw new Error("profile_file_invalid");
  }
  if (!Array.isArray(value.profiles)) throw new Error("profile_file_invalid");
  const profiles = value.profiles.map(validateProfile);
  if (new Set(profiles.map((profile) => profile.profileId)).size !== profiles.length) {
    throw new Error("profile_file_duplicate_id");
  }
  const activeProfileId =
    typeof value.activeProfileId === "string" ? value.activeProfileId : undefined;
  if (
    value.activeProfileId !== undefined &&
    (!activeProfileId ||
      !profiles.some((profile) => profile.profileId === activeProfileId))
  ) {
    throw new Error("active_profile_invalid");
  }
  return activeProfileId ? { profiles, activeProfileId } : { profiles };
}

function requireText(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256) throw new Error("profile_text_invalid");
  return trimmed;
}

function isMissing(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function validateProfile(value: unknown): PerformerProfile {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "profileId",
      "displayName",
      "backendKind",
      "authenticationMethod",
      "codexTurnSettings",
      "executionPolicy",
      "createdAt",
      "updatedAt",
    ]) ||
    typeof value.profileId !== "string" ||
    typeof value.displayName !== "string" ||
    value.backendKind !== "codex" ||
    !["chatgpt", "api_key"].includes(String(value.authenticationMethod)) ||
    !isRecord(value.codexTurnSettings) ||
    !hasOnlyKeys(value.codexTurnSettings, [
      "model",
      "reasoningEffort",
      "isFastModeEnabled",
    ]) ||
    typeof value.codexTurnSettings.model !== "string" ||
    typeof value.codexTurnSettings.reasoningEffort !== "string" ||
    typeof value.codexTurnSettings.isFastModeEnabled !== "boolean" ||
    !isRecord(value.executionPolicy) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("profile_file_invalid");
  }
  const profile = value as unknown as PerformerProfile;
  validateSettings(profile.authenticationMethod, profile.codexTurnSettings);
  validateExecutionPolicy(profile.executionPolicy);
  requireText(profile.profileId);
  requireText(profile.displayName);
  return profile;
}

function defaultExecutionPolicy(): AgentExecutionPolicy {
  return {
    sandboxMode: "workspace_write",
    commandAllowlist: [],
    commandDenylist: [],
  };
}

function validateExecutionPolicy(policy: AgentExecutionPolicy) {
  if (
    !isRecord(policy) ||
    !hasOnlyKeys(policy, [
      "sandboxMode",
      "commandAllowlist",
      "commandDenylist",
    ]) ||
    !["read_only", "workspace_write", "unrestricted"].includes(
      String(policy.sandboxMode),
    ) ||
    !validRules(policy.commandAllowlist) ||
    !validRules(policy.commandDenylist)
  ) {
    throw new Error("profile_execution_policy_invalid");
  }
}

function validRules(value: unknown): value is AgentExecutionPolicy["commandAllowlist"] {
  return Array.isArray(value) && value.length <= 64 && value.every((rule) =>
    isRecord(rule) &&
    hasOnlyKeys(rule, ["executable", "argvPrefix"]) &&
    validPolicyText(rule.executable) &&
    Array.isArray(rule.argvPrefix) &&
    rule.argvPrefix.length <= 16 &&
    rule.argvPrefix.every(validPolicyText)
  );
}

function validPolicyText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = Array.from(value).length;
  return length >= 1 && length <= 256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]) {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
