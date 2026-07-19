# Performer Event设计

状态：目标架构提案。Event只观察一次Root Turn的实时进度；丢失全部Event也不能改变Root、Leaf、Gate、
Conversation retry或delivery。

## 1. Event边界

Event可以表达Turn started、Provider-neutral progress、warning、sanitized error、heartbeat和已经
发布closed Result后的completion observation。

Event不能表达或触发Plan/children、Work完成、Human请求、Gate判定、Linear mutation、Git commit、
delivery、Conversation替换或下一Root。业务效果必须来自Agent broker commands和Linear/Git read-back。

## 2. Wire shape

```text
PerformerTurnEvent
  protocol_version
  turn_id
  root_issue_id
  performer_id
  sequence
  occurred_at
  body
```

Closed body union：

```text
PerformerTurnStartedEvent

PerformerProgressEvent
  stage:
    context_loaded
    analyzing
    editing
    checking
    waiting_human
    reviewing
    delivering
    finalizing
    waiting_provider

PerformerWarningRaisedEvent
  warning_code
  sanitized_summary

PerformerErrorRaisedEvent
  error_code
  sanitized_summary
  retryable

PerformerHeartbeatEvent

PerformerTurnCompletedEvent
  result_kind
  sanitized_summary
```

Event没有`work_issue_id`、target Leaf、Provider reasoning、tool arguments、free-form command、diff、raw
stdout/stderr、Token、credential、SDK object或raw exception。

Token usage不在Event中流式投影。Provider可能只在完整Turn返回时给出可靠usage，Performer只把最终
观察写入Result；缺失usage不影响业务read-back，也不能推断或合成中间token数。

## 3. 传输与correlation

Performer stdout是唯一Event transport，使用newline-delimited closed frames并逐帧flush；stderr只输出
脱敏诊断；Result原子写入Result文件。禁止event journal文件、Result旁路events数组或process退出后的
批量replay。

Conductor验证：

```text
turn_id matches
root_issue_id matches
performer_id matches the Command and current Root pointer
sequence equals the next expected value
```

重复、迟到、损坏或旧Conversation Event不投影。buffer有总bytes、单帧和帧数上限；可以丢弃旧
progress/heartbeat，但不能阻塞Provider和最终Result。

成功Turn先发布closed Result，再发`turn_completed`。Event中的`result_kind`只说明Result已发布，不能
替代Result或Linear/Git read-back。

## 4. Linear与Desktop映射

Conductor把Event写structured logs和Desktop runtime views。Linear只保留人需要理解的关键业务事件，
而这些应由Harness/Result handling创建Root Timeline Comment，不直接逐Event投影：

| Event | Linear行为 |
|---|---|
| Started / Progress / Heartbeat | 不写Linear |
| Warning | 只有需要用户动作时写一条去重Problem comment |
| Error | 由最终closed Result决定是否写retry/terminal comment |
| Completed | 不写completion comment，不表达Root完成 |

这避免Linear被tool activity和heartbeat淹没。Plan、Work completion、Gate findings、Conversation retry和
delivery由对应closed command/Result flow写人类可读comment。

## 5. Disconnect、restart与retry

- Event channel不持久化、不replay；
- Conductor restart不补历史Event；
- 新Root Turn使用新`turn_id`并从sequence 0开始；
- normal Turn retry继续current `performer_id`；
- Root-level Conversation retry替换ID后，所有旧ID Event永久stale；
- 是否继续Root只由Linear/Git和current Conversation决定。

## 6. 不变量

1. Event是best-effort observation，不是command、事实账本或heartbeat lease。
2. Event不能推进Workflow、commit、delivery或Conversation retry。
3. Event没有Leaf target，Root是唯一correlation业务单元。
4. Result和Event都不能替代Linear/Git read-back。
5. usage可以丢失，不决定业务行为。
6. stdout live stream是唯一Event transport，不保留journal或replay路径。
