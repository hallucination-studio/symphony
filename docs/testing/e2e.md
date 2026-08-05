# End-to-End Testing

The E2E suite proves the V1 Root workflow through a small set of observable
scenarios. It does not recreate retired workflow machinery or provide a second
operator control plane.

## Test Contract

Every scenario states:

```text
given: Root, workspace, run directory, and provider state
when: one public `run` launch or one internal scenario action
then: public Root state, Root managed snapshot, workspace, process, terminal
      role descriptions, Cycle history/result comments, Cycle file link/upload
      outcome, and pull-request outcome
cleanup: only resources allocated by that scenario
```

Assertions use public facts. They do not assert private call ordering,
unbounded process output, full Agent transcripts, provider payloads, raw
diagnostic file bytes, or commit identifiers. Exact role Markdown is public by
design: tests compare it only at the owned role descriptions. The typed Audit JSON
file is checked as the single Cycle upload, including `application/json` and
its returned file URL. Root snapshots are checked for exact markers and a local
RFC3339 `Updated at: <YYYY-MM-DDTHH:mm:ss.sss+/-HH:MM>` line. Cycle comment
ordering uses Linear `createdAt`; tests do not add or require a duplicate body
timestamp.

## Scenario Kit

The reusable kit lives under `tests/e2e/` and keeps boundary ownership explicit.

| Component | Responsibility |
| --- | --- |
| `ScenarioWorld` | Creates one isolated workspace, an external run directory, a temporary bare remote, and deterministic Root identifiers. It uses real filesystem and Git operations. |
| `LinearDriver` | Holds normalized Root, managed description regions, comments, Root State (including parsed `latest_audit`), Cycle records, exact terminal role descriptions, Cycle history/result comments, uploaded-file metadata, and public status in an in-memory provider double. |
| `AgentDriver` | Supplies scripted Execute/Audit Markdown files and Reconcile outcomes, and records only bounded launch facts. Execute Markdown remains untrusted. |
| `EvidenceReader` | Reads public Linear facts, bounded workspace status/diff evidence, and private run-directory file metadata; raw file bytes are never returned. |

The deterministic runner executes exactly one Execute and then a fresh read-only
Audit in series. Each prompt asks its role to write the final Markdown to
`cycle-NNN-executor-result.md` or `cycle-NNN-audit-result.md`; there is no second
summarization/format-repair Agent call. A failed Execute still reaches Audit,
and partial workspace changes remain available for inspection. A successful
scenario commits and pushes to the temporary remote before calling its injected
pull-request boundary.

## Layers

### Contract and CLI smoke

`black-box-runner.test.mjs` checks closed command values and the one public
entrypoint:

```text
conductor run
  --linear-root ENG-1
  --workspace /absolute/root-workspace
  --dir /absolute/root-run-directory
  --agent codex
  --execute-model <execute-model>
  --execute-reasoning-effort <execute-effort>
  --audit-model <audit-model>
  --audit-reasoning-effort <audit-effort>
  --max-cycles 3
```

The command is the only public execution entry. `--agent` is optional and
defaults to `codex`; role-level launch commands and unknown options are
rejected. Omitted role model/reasoning values use the user's local `~/.codex`
configuration and authentication. API keys and base URLs are startup
environment only, with role-specific values such as
`SYMPHONY_EXECUTE_CODEX_API_KEY` and `SYMPHONY_AUDIT_CODEX_API_KEY`; they are
not public request fields.

### Deterministic scenario

`deterministic-scenarios.test.mjs` combines `LinearDriver`, `AgentDriver`, and
`ScenarioWorld`:

- one frozen Cycle is created from Root input;
- Execute uses workspace-write access and writes one untrusted final Markdown file;
- a fresh read-only Audit inspects the real workspace;
- the exact Executor Markdown is appended once to the Execute description with
  one local RFC3339 `Updated at` line, without parsing;
- the exact Audit Markdown is appended once to the Audit description with one
  local RFC3339 `Updated at` line;
- the parsed Audit value is written to `cycle-NNN-audit-result.json`, read back
  and validated, then uploaded once as `application/json` for the Cycle;
- Cycle history/result comments record transitions, decisions, terminal fields,
  and a Markdown file link to the uploaded JSON or the current upload error
  (first 50 characters); their event time is Linear `createdAt`;
  an upload failure does not change the Audit verdict;
- Root Reconcile uses the Execute role configuration while Audit may use an
  independent provider, model, reasoning effort, key, and base URL;
- every Reconcile decision replaces the latest human-readable report in the
  managed Root suffix; `create_cycle` also copies it once to the new Cycle;
  completion reports use semantic created/updated/deleted paths, whole-worktree
  line deltas, verification evidence, and short exact token totals;
- every durable Root projection refreshes exactly one managed description block
  with a local RFC3339 `Updated at` line, while the immutable requirement bytes
  remain unchanged;
- an accepted Audit promotes task state and permits one terminal commit, push,
  and injected pull-request result;
- timed-out Execute facts do not bypass Audit, and failure retains the partial
  workspace without publication.

This layer is local, deterministic, and runs without provider or Agent
credentials.

The reusable result assertion checks the role-description structure and content,
accepting Linear's equivalent Markdown list-marker normalization. It also checks
the exact JSON filename/content type and re-read contents, the one uploaded-file
URL/error, and the parsed `latest_audit` verdict. Golden validates the Executor's
human-facing `Created`/`Updated`/`Deleted` file-change sections and rejects raw
Git porcelain status lines; this remains a display-format check, not semantic
task evidence. It deliberately does not inspect private JSONL/stderr bytes.
The deterministic scenario additionally proves continue and completion Root
reports, token accumulation across Reconcile/Execute/Audit, and `Unknown` when
any invocation lacks valid usage rather than estimating a total.

The visible Issue tree uses the frozen title contract: `[Cycle NNN]` followed by
an objective within the 80-character Cycle title limit, then exactly
`[Executor] Cycle NNN` and `[Audit] Cycle NNN`. Golden assertions inspect this
tree only as an operator projection; Root Reconcile is proved through
`RootState.latest_audit`, never through the Cycle DAG.

### Private diagnostic evidence

Scenario runners may inspect the external run directory to prove that a failed
Agent retained bounded raw JSONL, stderr, and causal error context. They may
check file existence, permissions, refs, and a mechanically indexed
`thread_id`, but never copy raw bytes into public assertions, Linear comments,
Root State, Audit prompts, logs, or test output. Unknown failures are diagnosed
from this causal evidence rather than an exhaustive reason-code taxonomy.

### Individual real boundaries

`real-boundary-runners.mjs` provides separate Linear, Agent, Git, and
pull-request runners. When explicitly enabled, they perform a bounded Linear
Root read, a Codex CLI probe, `git --version`, and `gh auth status`, respectively.
The supervisor reads a mode-600 `.env` file, partitions only allowlisted keys
to the owning boundary, and never prints values. Missing credentials, a
missing Root input, or an absent explicit enable flag returns a result such as:

```json
{"status":"blocked","boundary":"linear","reason":"credential_missing"}
```

`blocked` is an observed state, not a successful boundary check. A local run
must report it rather than silently replacing the external boundary with a
fake.

### Golden runner

`golden-runner.mjs` is the overall manual single-machine gate. It requires an
explicit enable flag, the allowlisted product credentials, a human Linear token,
and one unambiguous Linear project slug. It creates its own temporary Root Issue,
clones the current `origin` into an isolated workspace, and allocates an external
run directory. Callers do not supply a Root, workspace, or run-directory path.

The human token is used only to create and archive the test-owned Issue tree.
The built Conductor receives the product Linear and GitHub credentials plus the
role-partitioned Execute/Audit Codex startup credentials, not the human fixture
token. On completion the runner closes its pull request,
deletes its unique branch, archives only its own Issue tree, and removes only its
own temporary directories. Without the required credentials or project identity
it reports `blocked` and performs no launch. It never exposes credentials, raw
Agent output, or provider payloads.

When the golden Conductor or an external boundary fails, the runner archives
the private run-directory diagnostic evidence before cleaning any owned
temporary workspace, remote, branch, or Issue tree. The failure result exposes
only a stable reason and `diagnostic_ref` to the archive directory; archive
contents remain local with private permissions. Cleanup does not erase the
evidence needed to explain the failure, and caller-owned resources are never
cleaned.

The real Agent probe and golden scenario own their optional role model/effort
pairs instead of inheriting a product default. Scenario-specific overrides must
use `SYMPHONY_E2E_EXECUTE_*`/
`SYMPHONY_E2E_AUDIT_*` or `SYMPHONY_GOLDEN_EXECUTE_*`/
`SYMPHONY_GOLDEN_AUDIT_*` variables; when absent, the Codex process uses the
user's local configuration and authentication. No test assumes a model,
reasoning effort, or capability matrix supplied by Symphony.

The golden visible-tree queries also fetch the Root managed suffix, each role's
terminal description, and Cycle rationale/result comments. They check the
frozen title rules, exact Executor/Audit Markdown placement, one local RFC3339
`Updated at` line per terminal role description, and one visible
`[cycle-NNN-audit-result.json](<assetUrl>)`
file link in the mechanical Cycle Result. The real Gateway's successful JSON
upload is therefore proven at the public Linear boundary without assuming a
provider file-list schema. Golden also requires one continue report per Cycle
and one completion report with semantic file changes, line counts,
verification, and a short exact-or-unknown token total. Executor projection is
exactly one successful human report or one explicit bounded failure report;
an Audit-accepted Cycle is not rejected merely because Execute itself timed
out after leaving the correct workspace change. The runner does not download diagnostic JSONL
or stderr.

## Running

Run the contract, deterministic, real-boundary, golden, and supervisor tests locally:

```bash
npm run test:e2e:runner
npm run lint:e2e
```

Run the supervisor, which executes local layers and reports real-boundary and
golden status:

```bash
npm run test:e2e
```

The supervisor starts one bounded total-duration clock before local tests and
carries the remaining budget through the real-boundary and golden phases. A
deadline returns the sanitized `e2e_timeout` result. External failures return a
non-zero result with a sanitized reason; unavailable external systems are
reported with explicit `blocked` records and are not described as a complete
golden run.

## Required Outcomes

The suite covers these observable outcomes:

| Scenario | Observable result |
| --- | --- |
| public launch | only `run` accepts the Root launch contract |
| successful serial flow | accepted Audit, committed workspace, pushed temporary branch, and one PR URL |
| failed Execute | fresh Audit still runs and partial files remain |
| Markdown/JSON projection | Executor Markdown only in the Execute terminal description; Audit Markdown only in the Audit terminal description; re-read typed Audit JSON is the only Cycle upload; Cycle history comments use Linear `createdAt`; parsed fields enter `latest_audit` and Reconcile ignores the Cycle DAG |
| uploaded-file failure | Cycle Result exposes the current upload error (first 50 characters) while the Audit verdict and `latest_audit` remain unchanged |
| empty or invalid external setup | boundary result is `blocked` with a bounded reason |
| credential partition | secrets are available only to their owning real boundary and never emitted |
| diagnostic boundary | raw Agent JSONL/stderr/error context stays private in the external run directory; only refs are observable |
| golden fixture ownership | the runner creates its own Root, workspace, run directory, branch, and cleanup scope |
| golden failure archive | evidence is archived before owned external cleanup; result reports only `diagnostic_ref` |
| golden prerequisites absent | overall runner reports `blocked` before creating external resources |

Each scenario cleans only its temporary workspace, run directory, remote, and
test process resources. No runner resets, cleans, adopts, or deletes a caller
owned Root workspace.

## Explicit non-goals

The suite does not add a second summarization Agent call, treat Executor
Markdown as semantic evidence, upload JSONL/stderr, or use uploaded-file
success as a semantic gate. Executor Markdown receives only the fixed
human-facing shape check described above; Audit Markdown is parsed once into a
typed result, its re-read JSON is the only Cycle progression file, and Linear
must remain an exact, visible projection of the role descriptions, Cycle history
comments, Root snapshot, and JSON file;
diagnostic evidence stays private in the caller-owned run directory.
