# End-to-End Testing

The E2E suite proves the Root workflow through three observable layers:
`local`, `boundary`, and `golden`. It does not recreate retired workflow
machinery or provide a second operator control plane.

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
design: tests compare it only at the owned role descriptions. The Critic compact
envelope and free Markdown report are checked at the Critic description. The
`{envelope, report_markdown}` artifact is serialized once and uploaded as the
single Cycle file, including `application/json` and its returned file URL. Root
snapshots are checked for exact markers and a human-readable local `Updated at:
<YYYY-MM-DD HH:mm:ss GMT+/-HH:MM>` line. Cycle comment ordering uses Linear
`createdAt`; tests do not add or require a duplicate body timestamp.

## Scenario Kit

The reusable kit lives under `tests/e2e/` and keeps boundary ownership explicit.

| Component | Responsibility |
| --- | --- |
| `ScenarioWorld` | Creates one isolated workspace, an external run directory, a temporary bare remote, and deterministic Root identifiers. It uses real filesystem and Git operations. |
| `LinearDriver` | Holds normalized Root, managed description regions, comments, Root State (including parsed `latest_critique`), Cycle records, exact terminal role descriptions, Cycle history/result comments, uploaded-file metadata, and public status in an in-memory provider double. |
| `AgentDriver` | Supplies scripted Artist Markdown, Critic envelope/report files, and Reconcile outcomes, and records only bounded launch facts. Artist Markdown remains untrusted. |
| `EvidenceReader` | Reads public Linear facts, bounded workspace status/diff evidence, and private run-directory file metadata; raw file bytes are never returned. |

The deterministic runner executes exactly one Artist and then a fresh read-only
Critic in series. Each prompt asks its role to write the final Markdown to
`cycle-NNN-artist-result.md` or `cycle-NNN-critic-result.md`; there is no second
summarization/format-repair Agent call. A failed Artist still reaches Critic,
and partial workspace changes remain available for inspection. A successful
scenario commits and pushes to the temporary remote before calling its injected
pull-request boundary.

## Layers

### Local

#### Contract and CLI smoke

`black-box-runner.test.mjs` checks closed command values and the one public
entrypoint:

```text
conductor run
  --linear-root ENG-1
  --workspace /absolute/root-workspace
  --dir /absolute/root-run-directory
  --reconcile-agent codex
  --reconcile-model <reconcile-model>
  --reconcile-reasoning-effort <reconcile-effort>
  --artist-agent codex
  --artist-model <artist-model>
  --artist-reasoning-effort <artist-effort>
  --critic-agent codex
  --critic-model <critic-model>
  --critic-reasoning-effort <critic-effort>
  --max-cycles 3
```

The command is the only public execution entry. Each role's agent value is
optional and defaults to `codex`; role-level launch commands and unknown options
are rejected. Omitted role model/reasoning values use the user's local `~/.codex`
configuration and authentication. API keys and base URLs are startup
environment only, with role-specific values such as
`SYMPHONY_ARTIST_CODEX_API_KEY` and `SYMPHONY_CRITIC_CODEX_API_KEY`; they are
not public request fields.

#### Deterministic scenario

`deterministic-scenarios.test.mjs` combines `LinearDriver`, `AgentDriver`, and
`ScenarioWorld`:

- one frozen Cycle is created from Root input;
- Artist uses workspace-write access and writes one untrusted final Markdown file;
- a fresh read-only Critic inspects the real workspace;
- the exact Artist Markdown is appended once to the Artist description with
  one human-readable local `Updated at` line, without parsing;
- the exact Critic Markdown, containing one compact fenced JSON envelope followed
  by a free Markdown report, is appended once to the Critic description with one
  human-readable local `Updated at` line;
- the compact envelope and exact report are combined into one
  `{envelope, report_markdown}` artifact, serialized once to
  `cycle-NNN-critique-result.json`, and uploaded from those same bytes as
  `application/json` for the Cycle;
- Cycle history/result comments record transitions, decisions, terminal fields,
  and a Markdown file link to the uploaded JSON or the current upload error
  (first 50 characters); their event time is Linear `createdAt`;
  an upload failure does not change the Critic verdict;
- Reconcile, Artist, and Critic each use independent provider, model, reasoning
  effort, key, and base URL configuration;
- every Reconcile decision replaces the latest human-readable report in the
  managed Root suffix; `create_cycle` also copies it once to the new Cycle;
  completion reports use semantic created/updated/deleted paths, whole-worktree
  line deltas, verification evidence, wall-clock duration, and short exact token totals;
- every durable Root projection refreshes exactly one managed description block
  with a human-readable local `Updated at` line, while the immutable requirement bytes
  remain unchanged;
- an accepted Critic promotes task state and permits one terminal commit, push,
  and injected pull-request result;
- timed-out Artist facts do not bypass Critic, and failure retains the partial
  workspace without publication.

This layer is local, deterministic, and runs without provider or Agent
credentials.

The reusable result assertion checks the role-description structure and content,
accepting Linear's equivalent Markdown list-marker normalization. It also checks
the exact artifact filename/shape/content type, the one uploaded-file URL/error,
and the compact `latest_critique` checkpoint (including its artifact URL when
available). Golden validates the Artist's human-facing `Created`/`Updated`/`Deleted`
file-change sections and rejects raw Git porcelain status lines; this remains a
display-format check, not semantic task evidence. It deliberately does not
inspect private JSONL/stderr bytes.
The deterministic scenario additionally proves continue and completion Root
reports, token accumulation across Reconcile/Artist/Critic, and `Unknown` when
any invocation lacks valid usage rather than estimating a total.
It also proves the Root-only `Needs Human` gate: one question comment contains
concrete options, an unanswered Root is idle, and a later Root reply is consumed
as one accepted (`white_check_mark`) or rejected (`x`) batch without reading
descendant comments.

The visible Issue tree uses the frozen title contract: `[Cycle NNN]` followed by
an objective within the 80-character Cycle title limit, then exactly
`[Artist] Cycle NNN` and `[Critic] Cycle NNN`. Golden assertions inspect this
tree only as an operator projection; Root Reconcile is proved through
`RootState.latest_critique`, never through the Cycle DAG.

#### Private diagnostic evidence

Scenario runners may inspect the external run directory to prove that a failed
Agent retained bounded raw JSONL, stderr, and causal error context. They may
check file existence, permissions, refs, and a mechanically indexed
`thread_id`, but never copy raw bytes into public assertions, Linear comments,
Root State, Critic prompts, logs, or test output. Unknown failures are diagnosed
from this causal evidence rather than an exhaustive reason-code taxonomy.

### Boundary

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

### Golden

`golden-runner.mjs` is the overall manual single-machine gate. It requires an
explicit enable flag, the allowlisted product credentials, a human Linear token,
and one unambiguous Linear project slug. It creates its own `[E2E]` Root Issue and
private external run directory. It does not clone or supply a workspace. Root
Reconcile Prepare starts no Agent: when no preferred path is supplied it adopts
the invocation checkout, and when a preferred path is supplied it uses that
exact path or exposes the failure. Callers do not supply a Root, workspace, or
run-directory path.

The human token is used only to create and archive the test-owned Issue tree.
The built Conductor receives the product Linear and GitHub credentials plus the
role-partitioned Artist/Critic Codex startup credentials, not the human fixture
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
use `SYMPHONY_E2E_ARTIST_*`/
`SYMPHONY_E2E_CRITIC_*` or `SYMPHONY_GOLDEN_ARTIST_*`/
`SYMPHONY_GOLDEN_CRITIC_*` variables; when absent, the Codex process uses the
user's local configuration and authentication. No test assumes a model,
reasoning effort, or capability matrix supplied by Symphony.

The golden visible-tree queries also fetch the Root managed suffix, each role's
terminal description, and Cycle rationale/result comments. They check the
frozen title rules, exact Artist/Critic Markdown placement, the compact Critic
envelope plus free report, one human-readable local `Updated at` line per terminal
role description, and one visible
`[cycle-NNN-critique-result.json](<assetUrl>)`
file link in the mechanical Cycle Result. The real Gateway's successful JSON
upload is therefore proven at the public Linear boundary without assuming a
provider file-list schema. Golden also requires one continue report per Cycle
and one completion report with semantic file changes, line counts,
verification, wall-clock duration, and a short exact-or-unknown token total. Artist projection is
exactly one successful human report or one explicit bounded failure report;
an Critic-accepted Cycle is not rejected merely because Artist itself timed
out after leaving the correct workspace change. The runner does not download diagnostic JSONL
or stderr.

After a successful Golden run, the supervisor suppresses blocked `linear`,
`codex`, `git`, and `pr` probes covered by that run in its default result.
Setting `SYMPHONY_RUN_REAL_BOUNDARIES=1` retains those covered blocked probes for
explicit diagnostics; unknown boundaries and failed probes remain visible.

## Running

Run the local, boundary, and golden tests locally:

```bash
npm run test:e2e:runner
npm run lint:e2e
```

Run the supervisor, which executes the local layer and reports boundary and
Golden status:

```bash
npm run test:e2e
```

The supervisor starts one bounded total-duration clock before local tests and
carries the remaining budget through the boundary and Golden phases. A deadline
returns the sanitized `e2e_timeout` result. External failures return a non-zero
result with a sanitized reason; unavailable external systems are reported with
explicit `blocked` records. A successful Golden run suppresses only its covered
blocked probes by default; set `SYMPHONY_RUN_REAL_BOUNDARIES=1` to retain those
diagnostics.

## Required Outcomes

The suite covers these observable outcomes:

| Scenario | Observable result |
| --- | --- |
| public launch | only `run` accepts the Root launch contract |
| successful serial flow | accepted Critic, committed workspace, pushed temporary branch, structured pull-request Delivery, and one PR URL |
| failed Artist | fresh Critic still runs and partial files remain |
| Markdown/JSON projection | Artist Markdown only in the Artist terminal description; Critic envelope plus free report only in the Critic terminal description; one serialized `{envelope, report_markdown}` artifact is the only Cycle upload; Cycle history comments use Linear `createdAt`; compact fields plus the artifact URL enter `latest_critique` and Reconcile ignores the Cycle DAG |
| uploaded-file failure | Cycle Result exposes the current upload error (first 50 characters) while the Critic verdict and `latest_critique` remain unchanged |
| empty or invalid external setup | boundary result is `blocked` with a bounded reason |
| credential partition | secrets are available only to their owning real boundary and never emitted |
| diagnostic boundary | raw Agent JSONL/stderr/error context stays private in the external run directory; only refs are observable |
| golden fixture ownership | the runner creates only its Root Issue and private run directory; Root Reconcile Prepare starts no Agent, adopts the invocation checkout when no preferred path is supplied, and uses a supplied preferred path exactly |
| golden delivery | the temporary Golden workspace is successful only with a structured GitHub pull-request Delivery; branch or files Delivery fails before cleanup and is archived for diagnosis |
| golden failure archive | evidence is archived before owned external cleanup; result reports only `diagnostic_ref` |
| golden prerequisites absent | overall runner reports `blocked` before creating external resources |
| Golden coverage | successful Golden suppresses covered blocked probes by default; explicit real-boundary diagnostics retain them |

Each scenario cleans only its temporary workspace, run directory, remote, and
test process resources. No runner resets, cleans, adopts, or deletes a caller
owned Root workspace.

## Explicit non-goals

The suite does not add a second summarization Agent call, treat Artist
Markdown as semantic evidence, upload JSONL/stderr, or use uploaded-file
success as a semantic gate. Artist Markdown receives only the fixed
human-facing shape check described above. Critic Markdown is parsed once for its
compact envelope; the complete `{envelope, report_markdown}` artifact is
serialized once and uploaded, while only the compact checkpoint and artifact URL
enter `latest_critique`. Linear must remain an exact, visible projection of the
role descriptions, Cycle history comments, Root snapshot, and JSON file;
diagnostic evidence stays private in the caller-owned run directory.
