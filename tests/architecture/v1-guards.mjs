import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const authoredRoots = [
  "apps/conductor/src",
  "apps/performer/src",
  "apps/podium-desktop/src",
  "apps/podium-desktop/src-backend",
  "apps/podium-desktop/src-tauri/src",
  "packages/podium/src",
  "packages/contracts/schemas",
];

const manifestFiles = [
  "package.json",
  "apps/conductor/package.json",
  "apps/performer/pyproject.toml",
  "apps/podium-desktop/package.json",
  "apps/podium-desktop/src-tauri/Cargo.toml",
  "packages/podium/package.json",
  "packages/contracts/package.json",
  "packages/contracts/generated/rust/Cargo.toml",
];

const linearOwnerPaths = new Set([
  "packages/podium/package.json",
  "packages/podium/src/internal/linear-gateway/internal/LinearSdkImpl.ts",
]);
const providerOwnerPatterns = [
  /^apps\/performer\/pyproject\.toml$/,
  /^apps\/performer\/src\/performer\/backends\/codex\/codex_backend_impl\.py$/,
];
const roleImportPatterns = {
  podium: /^@symphony\/podium(?:$|\/)/,
  conductor: /^@symphony\/conductor(?:$|\/)/,
  performer: /^@symphony\/performer(?:$|\/)/,
};
const forbiddenRoleImports = {
  conductor: ["podium", "performer"],
  podium: ["conductor", "performer"],
  performer: ["podium", "conductor"],
  desktop: ["conductor", "performer"],
  shared: [],
};

const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".py",
  ".rs",
  ".json",
  ".toml",
]);

function violation(file, code, summary) {
  return { file, code, summary };
}

function importSpecifiers(source) {
  const patterns = [
    /(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g,
    /(?:import|require)\(\s*["']([^"']+)["']\s*\)/g,
  ];
  return patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1]),
  );
}

function importedRole(file, specifier) {
  for (const [role, pattern] of Object.entries(roleImportPatterns)) {
    if (pattern.test(specifier)) return role;
  }
  if (!specifier.startsWith(".")) return null;
  const resolved = path
    .normalize(path.join(path.dirname(file), specifier))
    .split(path.sep)
    .join("/");
  return roleFor(resolved);
}

function schemaPropertyNames(source) {
  try {
    const schema = JSON.parse(source);
    const names = [];
    const visit = (value) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === "object") {
        if (value.properties && typeof value.properties === "object") {
          names.push(...Object.keys(value.properties));
        }
        Object.values(value).forEach(visit);
      }
    };
    visit(schema);
    return names;
  } catch {
    return [];
  }
}

function roleFor(file) {
  if (file.startsWith("apps/conductor/")) return "conductor";
  if (file.startsWith("apps/performer/")) return "performer";
  if (file.startsWith("packages/podium/")) return "podium";
  if (file.startsWith("apps/podium-desktop/")) return "desktop";
  return "shared";
}

export function inspectAuthoredFile(file, source) {
  const normalizedFile = file.split(path.sep).join("/");
  const violations = [];

  if (
    /(?:@linear\/sdk|from\s+["']linear["']|require\(["']@linear\/sdk)/.test(
      source,
    ) &&
    !linearOwnerPaths.has(normalizedFile)
  ) {
    violations.push(
      violation(
        normalizedFile,
        "linear_sdk_outside_podium",
        "Linear SDK is owned only by Podium LinearSdkImpl",
      ),
    );
  }

  if (
    /(?:openai-codex|codex[_-]sdk|from\s+openai\b|import\s+openai\b)/i.test(
      source,
    ) &&
    !providerOwnerPatterns.some((pattern) => pattern.test(normalizedFile))
  ) {
    violations.push(
      violation(
        normalizedFile,
        "provider_sdk_outside_performer_backend",
        "Provider SDK is owned only by the Performer Codex backend",
      ),
    );
  }

  const role = roleFor(normalizedFile);
  const specifiers = importSpecifiers(source);
  const importedRoles = specifiers
    .map((specifier) => importedRole(normalizedFile, specifier))
    .filter(Boolean);
  if (forbiddenRoleImports[role].some((target) => importedRoles.includes(target))) {
    violations.push(
      violation(
        normalizedFile,
        "cross_role_import",
        "roles may communicate only through generated protocols",
      ),
    );
  }
  if (
    specifiers.some(
      (specifier) =>
        /\/internal(?:\/|$)/.test(specifier) &&
        importedRole(normalizedFile, specifier) !== role,
    )
  ) {
    violations.push(
      violation(
        normalizedFile,
        "cross_role_internal_import",
        "role internals cannot be imported across package boundaries",
      ),
    );
  }

  if (role === "conductor") {
    if (
      /(?:database|sqlite|workflow[-_]?db|checkpoint|operation[-_]?journal|dispatch[-_]?queue)/i.test(
        normalizedFile,
      ) ||
      importSpecifiers(source).some((specifier) =>
        /(?:sqlite|database|checkpoint|journal|queue|leveldb|rocksdb)/i.test(
          specifier,
        ),
      ) ||
      /new\s+(?:Database|Sqlite|Queue|Journal|Checkpoint)\b/.test(source)
    ) {
      violations.push(
        violation(
          normalizedFile,
          "conductor_persistence",
          "Conductor must remain database, queue, checkpoint, and journal free",
        ),
      );
    }
    if (
      /(?:priority|blocker|fairness|multi[-_]?root)/i.test(normalizedFile) ||
      /(?:class|interface|type|function|const)\s+\w*(?:PriorityRootScheduling|BlockerScheduling|FairRootScheduling|MultiRootScheduling)\w*/.test(
        source,
      )
    ) {
      violations.push(
        violation(
          normalizedFile,
          "future_scope",
          "V2+ scheduling vocabulary is forbidden in V1 implementation",
        ),
      );
    }
  }

  if (
    /(?:readFile|readFileSync|open|read_to_string)[\s\S]{0,300}(?:auth\.json|config\.toml|CODEX_HOME)/.test(
      source,
    )
  ) {
    violations.push(
      violation(
        normalizedFile,
        "codex_owned_file_access",
        "Symphony code must not directly read Codex-owned files",
      ),
    );
  }

  if (
    role === "podium" &&
    (/(?:root[-_]?workflow|linear[-_]?tree|root[-_]?gate)/i.test(
      normalizedFile,
    ) ||
      /(?:class|interface|type|function|const)\s+\w*(?:RootActionPolicy|LinearTreeTraversal|RunRootGateAction)\w*/.test(
        source,
      ))
  ) {
    violations.push(
      violation(
        normalizedFile,
        "podium_workflow_policy",
        "Podium cannot own Root workflow decisions",
      ),
    );
  }

  if (normalizedFile.includes("schemas/podium-client/")) {
    const forbiddenBrowserFields = new Set([
      "accesstoken",
      "refreshtoken",
      "authorization",
      "authorizationheader",
      "cookie",
      "password",
      "clientsecret",
      "apikey",
      "codexhome",
      "performerid",
      "repositoryroot",
      "canonicalpath",
      "worktreeroot",
      "secretvalue",
      "credential",
    ]);
    const hasForbiddenField = schemaPropertyNames(source).some((field) =>
      forbiddenBrowserFields.has(field.replaceAll("_", "").toLowerCase()),
    );
    if (hasForbiddenField) {
      violations.push(
        violation(
          normalizedFile,
          "browser_secret_surface",
          "browser schemas cannot expose credentials, private paths, or Provider handles",
        ),
      );
    }
  }

  if (
    normalizedFile.includes("schemas/") &&
    /"(?:provider_config|provider_settings|settings_map|arbitrary_metadata)"\s*:/.test(
      source,
    )
  ) {
    violations.push(
      violation(
        normalizedFile,
        "arbitrary_provider_config",
        "contracts allow only closed CodexTurnSettings",
      ),
    );
  }

  if (
    /(?:class|interface|type|function|const)\s+\w*(?:ParallelPerformer|PlanRevision|SourceRevision|CommentRevision|WorkflowCheckpoint|DispatchQueue|OperationJournal|Verification|Manifest|Evidence|DeliveryReceipt|ClaudeBackend|SecondProvider|WebApplication|WebServer|EncryptedProfile|ProfileDatabase|AutomaticMerge|AutomaticRootDone|CompatibilityShim)\w*/.test(
      source,
    )
  ) {
    violations.push(
      violation(
        normalizedFile,
        "future_product_scope",
        "V1 implementation cannot prebuild explicitly excluded product concepts",
      ),
    );
  }

  return violations;
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
    } else if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function findArchitectureViolations(root) {
  const files = [];
  for (const authoredRoot of authoredRoots) {
    files.push(...(await walk(path.join(root, authoredRoot))));
  }
  files.push(...manifestFiles.map((file) => path.join(root, file)));

  const violations = [];
  for (const file of [...new Set(files)].sort()) {
    const relativeFile = path.relative(root, file);
    const source = await readFile(file, "utf8");
    violations.push(...inspectAuthoredFile(relativeFile, source));
  }
  return violations;
}
