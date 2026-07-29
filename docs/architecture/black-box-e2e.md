# 并行前台黑盒端到端验收

状态：目标架构提案。本文是foreground parallel E2E topology、Cases、final evidence和verdict的唯一事实源。测试只通过
产品public boundary、Linear native surface和Git/SCM观察系统。

## 1. Scope record

```text
authorized
  - provision isolated Linear/Git test resources
  - start multiple real Conductor/Performer processes
  - use an independent Linear human actor
  - stop a selected process and remove an exact test Root worktree for recovery cases
  - fresh-read final native Linear/Git evidence

required_consequences
  - prove no replay of terminal tasks
  - prove Human Action comment recovery
  - prove missing-worktree rematerialization and invalid-Git fresh execution generation
  - prove no machine payload or generated event comments in Linear

out_of_scope
  - production migration
  - Desktop workflow UI
  - test-only workflow commands or direct internal imports

assumptions_requiring_approval
  - none for isolated test resources

deferred_ideas
  - additional Providers and multi-writer Roots
```

## 2. Boundary

E2E driver可以：

- 使用正式operator commands配置Binding/Profile并start/stop processes；
- 以E2E Human Actor通过Linear公开API创建、delegate、comment、reply、edit和resolve；
- 读取Linear native Issues、fields、comments、Activity和Git/SCM facts；
- 在隔离Case中停止process并移除已解析且验证过的exact worktree。

E2E driver禁止：

- import产品`internal` module或实例化Impl；
- direct-write `podium.db`、Profile files或Provider state；
- 直接修改Plan/Work/Verify/Finding来制造成功；
- 创建Human Action request或代表Symphony写resolution；
- 调用test-only workflow endpoint、fake clock或synthetic completion；
- 把logs、process exit或timeout当作workflow pass evidence；
- 在runner重写Root Reconciliation或Human Action lifecycle。

## 3. Environment topology

一个Campaign至少包含：

```text
one isolated Linear workspace/project/team
one isolated Git repository + remote/SCM test target
three independent Conductor processes
three matching Performer processes
one Podium Linear boundary
one independent E2E Human Actor
one case-local Root and branch namespace per Case
```

Processes通过start barrier并发启动。每个Case的Root、branch、worktree和native Issue IDs互不复用。Project policy、status catalog、
labels和repository base在Case启动前验证。

## 4. Campaign lifecycle

```text
validate tools and credentials
-> provision isolated Project/repository
-> permanently delete every active and archived Issue from the explicitly authorized isolated Project and fresh-read zero Issues
-> start product processes concurrently
-> create all case Roots without delegation
-> assert undelegated zero side effects
-> delegate Roots through native Linear
-> run Human Actor operations at declared barriers
-> wait all Cases with bounded deadlines
-> stop writers and discard polling caches
-> fresh-read Final Evidence Snapshot per Case
-> evaluate independent assertions
-> bounded cleanup
```

Campaign使用all-settled语义：一个Case失败不能取消其他Case的evidence collection。cleanup失败单独报告，不能覆盖Case verdict。

Project reset是test-resource lifecycle，不是产品workflow mutation。只有`.env`精确选择、target setup明确授权且setup read-back返回的
隔离E2E Project可以进入reset。reset writer必须是已完成独立身份read-back的E2E Human Actor API credential；Symphony OAuth actor只服务
Podium产品边界，不能尝试永久删除，也不能作为fallback。runner必须使用只读取Issue ID和pageInfo的compact query分页读取该Project的全部
active和archived Issues，以每次最多25个`issueDelete(permanentlyDelete: true)` alias的bounded mutation batches逐一移除，并验证每个alias都返回
`success = true`。然后以相同`includeArchived = true` compact query fresh-read零Issues，之后才能启动Podium和Conductor。只archive旧Issues不构成reset，因为Project Root
Index必须读取archived authority facts；按title、label、creator、时间或本次Campaign namespace过滤旧Issues同样禁止。任一delete或
read-back不完整都fail closed，不能用新的Root掩盖历史测试资源。

## 5. Progressive acceptance ladder

Full Campaign不是首个真实boundary诊断工具。产品按同一个workflow的observer-only early exits逐层验收；observer只读production
facts/events，不写test marker、私有checkpoint或替代workflow mutation：

| Level | Stop condition | 新证明的真实boundary |
|---|---|---|
| L0 | Podium、Host、one Conductor与Performer handshake/profile ready | process/runtime readiness |
| L1 | one Root admitted并出现在owning Conductor fresh Root Index | Linear routing/discovery |
| L2 | first Root turn被Provider接受且gate-specific output strict-valid | Performer/Provider Root contract |
| L3 | workspace、initial Cycle与Plan targeted read-back成立 | first native mutation convergence |
| L4 | lossless Plan Result与完整native DAG seal digest一致 | Plan/compiler/DAG materialization |
| L5 | one ready Work完成且scoped Git/check evidence read-back | Work/Git |
| L6 | Verify通过exact immutable revision且Cycle成功收口 | Verify/Finding/Cycle |
| L7 | push/PR link和Root `In Review` targeted read-back | Delivery Intent |
| L8 | exact remote PR/head/check/review/merge state满足Project policy | Remote SCM Acceptance |
| L9 | 本文eight-case 14-Root Campaign | concurrency/recovery/full regression |

每层最多新增一个independently failing owner，并有独立deadline、correlation和verdict。L0-L8中未被产品scope要求的层必须在claim中
明确排除，不能默认为通过。只有前一层稳定通过后才运行下一层；L9最后运行。local harness/fake/fixture只能证明runner contract，
不能证明其替代的真实boundary。

## 6. Immutable Case definition

每个Case启动前固定：

```text
case_id
root_requirement
repository_fixture
declared_human_operations[]
expected_boundary
required_assertions[]
prohibited_assertions[]
coverage_requirements[]
deadline
```

runner不能根据运行中结果修改requirement或放宽assertions。每个人类操作记录expected target native ID、actor和precondition；
unexpected product状态产生`failed`或`incomplete`，不能由runner“帮忙推进”。

## 7. Common assertions

每个Case至少验证：

| ID | Required condition |
|---|---|
| `case_scope_isolated` | 只引用Case-local Root graph、branch、worktree和SCM facts |
| `complete_native_coverage` | active/archived descendants、labels、statuses、relations、comments、threads、reactions、attachments和Activity分页完整 |
| `native_identity_consistent` | kind label、parent topology、native ID和relation scope一致 |
| `requirement_preserved` | Root current description包含全部已确认需求，没有模型发明的scope |
| `human_provenance_preserved` | 每个human answer/approval可定位到authorized actor、native comment/reply和Activity |
| `native_result_evidence` | Stage conclusions可由Issue status/labels/comments/Findings和Git facts证明 |
| `delivery_consistent` | Root `In Review`时Cycle、Verify、commit、checks和PR/link指向same revision |
| `terminal_nodes_not_dispatched` | terminal Issue没有后续`In Progress` Activity或新的execution target使用同一native ID |
| `work_epoch_fenced` | Work terminal response后旧turn不能再改变worktree；commit/Verify读取的是epoch retirement后的fresh evidence |
| `agent_tree_not_workflow` | Linear、Desktop和Git history中不存在agent path、mailbox、tree status或per-agent commit/branch |
| `human_content_only` | Symphony Linear content没有machine serialization、hidden marker、internal receipt或自动step-by-step comments |
| `no_test_control_facts` | 成功链中没有E2E writer创建的product facts |

coverage缺失产生`incomplete`，不能降级为passed。

## 8. Mandatory Cases

### 8.1 `approved_happy_path`

场景：完整Root requirement形成Plan，产品创建Plan Approval Root thread，human明确批准，Work/Verify完成并交付。

必须证明：

- Approval request是Root top-level Symphony comment，native-mentions exact Plan；
- fresh Root没有execution history时，initial worktree creation不会产生`Execution Invalidated`；
- authorized human reply严格早于Plan `Done`和任何Work `In Progress` Activity；
- resolution reply、receipt、resolved state和Plan/Cycle native consequence一致；
- Cycle Tree包含Plan、all required Work、Verify和Findings；
- Root在`In Review`，matching verified commit与PR/link一致；
- 不存在额外自动progress comments。

### 8.2 `plan_rejected_and_replanned`

场景：human拒绝first Plan，产品创建fresh Plan和fresh Approval thread。

必须证明：

- rejection actor、reply和旧Plan target可读；
- rejected Plan terminal/archived且identity不变；
- fresh Plan使用不同native ID，旧Approval不批准fresh Plan；
- 旧Plan没有Work dispatch；
- fresh request mention fresh Plan，不覆盖旧thread历史。

### 8.3 `information_requested_and_answered`

场景：产品请求缺失信息，human回答后形成fresh Plan。

必须证明：

- Information request具体、可回答且host在Root；
- answer来自authorized human；
- answer在thread resolve前已经合并进Root description；
- fresh Plan包含该信息且没有默认猜测；
- restart后不会再次请求已经纳入Root description的相同信息。

### 8.4 `root_revision_and_comment`

场景：human按预声明顺序修改Root description、增加ordinary comment、编辑comment并resolve/reopen thread。

必须证明：

- 每个body version和thread transition可由native Activity独立识别；
- applied input有check receipt和matching native consequence；未采用input有cross receipt与原因；
- human edit晚于receipt时fresh input再次处理；
- destructive requirement change使旧Cycle terminal并创建successor；
- product-authored comments不被当作human input。

### 8.5 `parallel_multi_conductor`

场景：至少三个Conductor同时处理不同Roots。

必须证明：

- 至少两个process在runtime interval上真实overlap；
- 每个Root任一时刻只有一个matching writer-domain interval，且证据能定位到唯一routing label、Binding process generation和
  native mutation actor；
- Work descendants即使并行运行也不形成额外Root writer domain，且旧epoch在domain handoff后没有late mutation；
- native facts和Git branches无跨Case引用；
- duplicate wake没有产生duplicate Issues、comments或commits；
- 一个process失败不终止其他Roots。

runtime interval只证明并行拓扑；workflow success仍只由Final Evidence Snapshot证明。

### 8.6 `same_conductor_preemption`

场景：同一个Conductor负责多个eligible Roots，Priority较高Root在下一安全边界先获得iteration。

必须证明：

- preemption只发生在turn/mutation安全边界；
- 不interrupt已经进入Provider的turn来伪造公平性；
- Root排序不写入Linear workflow状态；
- 被延后Root的terminal nodes未重新dispatch。

### 8.7 `conductor_restart_recovery`

场景：worktree仍存在时，在Plan、Work或Verify的`In Progress`阶段停止Conductor/Performer再启动。

必须证明：

- worktree identity、branch和partial Git facts保留；
- 遗留`In Progress` Issue收敛为`Interrupted`，不以同一ID重跑；
- 若Interrupted Plan继续，使用fresh Plan identity；若Interrupted Work/Verify继续，使用带Symphony recovery provenance的fresh
  successor Cycle，并证明旧approved DAG未被改写；
- 若Interrupted Stage结束current Cycle，只产生一个`Canceled` Cycle update，且恰好保留`Recovery Exhausted`或
  `Recovery Abandoned`、canonical explanation和matching Symphony actor/version；restart后直接进入non-success terminal review，
  Root保持nonterminal且任何delivery effect为零；
- restart前已经`Done`的Issues没有新`In Progress` Activity；
- Human Action threads、Root description和approved target facts不丢失；
- stale process output不能materialize，旧Work epoch也不能继续写worktree。

### 8.8 `missing_worktree_recovery`

场景包含两个隔离分支：先停止matching processes、取得replacement `BindingProcessFence`并验证exact test worktree后移除它；
第一分支保留可验证branch/commits，第二分支还使case-local execution branch不可恢复，再启动Conductor。

必须证明：

- product在解释旧execution readiness前检测到worktree missing；
- branch/commits完整时从existing branch重建worktree，保留current execution tree和Git code facts；
- branch不可恢复时旧nonterminal Cycle为`Canceled + Execution Invalidated`，旧execution descendants全部archive；
- 旧`Done`和approval facts不为new generation提供completion或authorization；
- invalid old branch没有被重新挂载；fresh branch/worktree从repository base创建；
- fresh Cycle、Plan、Work、Verify全部使用new native IDs；
- fresh Plan只基于Root Reconstruction Set；
- Root description中已确认信息和全部Root comment threads仍存在；
- exact new Plan需要fresh Approval thread。

## 9. Final Evidence Snapshot

settle后runner必须丢弃所有poll cache并fresh-read：

1. Root current fields与完整active/archived descendants；
2. Team status catalog、labels、parents、relations和archive flags；
3. comments、replies、reactions、thread state、attachments与required Activity；
4. Git repository、worktree list、branches、commits、trees、diffs和checks；
5. SCM PR/link和delivery revision；
6. product process identity/interval，仅用于topology assertions。

每个assertion返回其独立source references和coverage。不能用一个Case级boolean掩盖缺失事实，也不能用logs替代Linear/Git
workflow evidence。

## 10. Verdict

```text
passed
  all required assertions true
  all prohibited assertions absent
  all coverage complete

failed
  at least one required assertion false
  or a prohibited fact exists

incomplete
  deadline/coverage/external boundary prevents a conclusive evaluation
```

`incomplete`不是soft pass。reporter必须输出Case、assertion ID、sanitized reason和source references；不能输出tokens、raw
credentials、Provider transcript或unbounded Linear content。

## 11. Runner organization

```text
tools/e2e/
  campaign
  environment
  human-actor
  cases/
  polling
  final-evidence
  assertions
  verdict
  reporter
```

process management、polling、deadline、Linear pagination、Git evidence和cleanup各只有一份实现。Case files只声明input与
assertions，不创建process、不解析private comment protocol、不修改product state。

## 12. 不变量

1. E2E是产品外black-box consumer，不是第二个control plane。
2. Human Actor使用独立identity，不能由Symphony credential代替。
3. pass只来自fresh native Linear/Git evidence。
4. normal restart不重跑terminal Issue；missing worktree保留可验证Git，Git execution facts无效时才创建fresh identities。
5. Human Action comment content、actor、target scope和native consequences必须完整保留。
6. Machine payload和自动step comments在Linear中为零。
7. Case failure不取消其他Case evidence collection。
