# V4 Agent Cluster

状态：目标架构提案。本文只定义V4如何在
[V3 Agent Symphony Harness](agent-symphony-harness.md)内部增加多个trusted Agents；不重新定义Root
scheduling、Linear workflow、Harness commands或Git delivery。

## 1. 决定

V4把一个已经被调度的Root从单Agent lane扩展为Agent Cluster。Root仍是外部调度、current
Conversation、worktree、delivery和retry authority；Cluster不是Workflow graph、业务Queue或持久状态机。

```text
Root scheduled by V3
-> resume Root coordinator Conversation
-> coordinator requests bounded child Turns
-> child results land in Linear/Git or are discarded
-> coordinator read-backs and continues the Root
```

Root current `performer_id`属于coordinator。planner/writer/reviewer child Conversations只属于当前
Cluster execution，不成为Root或Leaf的durable session pointers。

## 2. Scope record

```text
authorized
  - coordinator、planner、writer和reviewer roles
  - transient child Turn broker与有界analysis fan-out
  - 同一Root worktree的single-writer scheduling
  - fresh Reviewer与Writer Conversation隔离
  - 所有顶层/child Turns共享capacity和command broker
  - 每个trusted Agent继承V3的sandbox mode和command allowlist/denylist

required_consequences
  - Root仍是唯一top-level dispatch和retry单元
  - Linear/Git继续是唯一durable Workflow/code authority
  - role、dispatch handle、fan-in和child Result全部transient
  - coordinator loss走V3 Root-level retry，不恢复Cluster graph
  - child结论只有写入Linear/Git并read-back后才能影响Root

out_of_scope
  - V4引入第二Provider Backend
  - durable Agent Queue、mailbox、task/dispatch DB或Stage checkpoint
  - 用户从Issue文本定义Agent topology、Profile或Backend
  - 多writer同时修改一个Root worktree、自动merge或per-Agent delivery

assumptions_requiring_approval
  - none

deferred_ideas
  - V5多Provider Performer
  - 独立worktree的并行writer与显式集成
  - 用户可配置Agent topology
```

## 3. Cluster配置与roles

```text
AgentClusterConfig
  agents[]
    agent_key
    performer_profile_id
    allowed_roles[]
    execution_policy
  concurrency_limit
```

| role | 主要职责 |
|---|---|
| `coordinator` | 理解整个Root、安排children、汇总事实、控制Gate和delivery |
| `planner` | 研究约束、提出Plan/criteria |
| `writer` | 完成一个明确Issue的代码和checks |
| `reviewer` | fresh检查Root scope、diff、checks和delivery条件 |

Role只决定child Turn的trusted prompt和context，不是Issue state或固定transition。Profile、Agent和
role只能来自trusted Cluster config；Linear文本或coordinator goal不能改写它们。

## 4. Child Turn broker

Coordinator可以请求bounded child Turn：

```text
symphony agent dispatch --issue <id> --role <planner|writer|reviewer>
  [--lens <closed-lens>] --goal-file <path|-> --json
symphony agent await --turn <turn-id> --json
symphony agent cancel --turn <turn-id> --json
```

```text
ChildAgentTurnRequest
  turn_id
  root_issue_id
  target_issue_id?
  agent_key
  role
```

这里的`target_issue_id`只限定Root内部child Turn的工作上下文，不把Leaf提升为跨Root scheduling或durable
retry单元。Goal是untrusted task context；Conductor重新生成trusted Harness和command catalog。

`await`只返回bounded process observation。需要跨child crash、coordinator crash或Root retry保留的
Plan、findings、work、checks和decisions必须已经写入Linear/Git，否则可以丢弃并重新dispatch。

## 5. 并发与single writer

- 同一Root同时最多运行一个writer；
- writer、Conductor commit和Git read-back按顺序执行；
- planner/reviewer使用immutable Git snapshot；
- analysis child Turns可以fan-out，但每个participant消耗真实capacity；
- 不同Root的writer只有在worktree、Profile和runtime capacity隔离时才可并行；
- child/provider subprocess必须在Turn结束时被清理；
- fresh Reviewer使用新Conversation，不resume Writer，也不修改workspace。

Cluster config、capacity permit、fan-out membership、child handles和Results不写Linear，也不写Conductor
DB。资源admission不能改变Linear Priority、blocker或Root scheduling。

## 6. Completion authority

Child sender必须与current child Turn/Conversation匹配；只知道`turn_id`、Root/Issue ID或payload
字段不能证明完成。late heartbeat、old writer completion和已取消Turn的commands必须被拒绝。

Reviewer findings/pass只有写入对应Linear comment/status并read-back后才影响Root。Writer修改只有
Git commit/checks和Linear completion evidence都存在后才算durable。Coordinator bounded summary和
child Result不替代这些事实。

## 7. 恢复

Child Turn失败但Root coordinator仍存在时，coordinator可以从最新Linear/Git重新dispatch该child；
不恢复旧child process或attempt。

Coordinator Conversation不可恢复、Conductor/runtime crash或Cluster process失效时：

```text
terminate all child process trees
-> discard child handles
-> preserve Linear/Git facts
-> run V3 Root-level Conversation retry
-> start a fresh Root coordinator
-> rebuild the entire Cluster plan from the Root
```

不恢复stage membership、dispatch graph、fan-in、attempt、mailbox或model Result。旧child即使迟到返回，
也因Root current Conversation已经变化而无法通过mutation precondition。

## 8. V4验收边界

1. V4复用V3 Root context、command registry、broker、read-back和Root retry。
2. Root仍是唯一top-level dispatch/Conversation/retry authority。
3. Role/Agent/Profile只能来自trusted Cluster config。
4. target Issue只限定child context，不形成Leaf durable dispatch。
5. 同一Root worktree同时最多一个writer；其他Agent看到immutable snapshot。
6. Fresh Reviewer不恢复Writer Conversation，也不修改workspace。
7. 所有participant计入真实capacity。
8. coordinator loss从Root重新开始，不恢复dispatch graph或fan-in。
9. Cluster不增加数据库、业务Queue、Stage checkpoint或mirrored Issue state。
10. V4仍只使用Codex Backend；多Provider属于V5。
