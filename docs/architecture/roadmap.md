# Symphony 架构 Roadmap 与 V1边界

状态：目标版本边界。本文描述未来四个大版本逐步完成目标架构，不包含日期、人员、迁移步骤或当前代码实施计划。

## 1. Roadmap原则

1. 每个版本都形成Podium Desktop、Linear、Conductor、Performer和Git的完整纵向闭环。
2. Linear Tree始终是Workflow权威，不在后续版本为Conductor引入任何数据库。
3. Interface作为扩展边界保留，但未来实现只有获得产品授权后才加入。
4. 版本只扩大已明确的能力，不为未来版本预建空状态、空表或不可达分支。

## 2. 四个大版本

| 版本 | 主题 | 完成边界 |
|---|---|---|
| V1 | 单Root完整闭环 | Codex Profiles、一个Root、一个worktree、Plan Approval Node、顺序Work Nodes/Human Nodes、Root Gate、PR或branch、单Conductor Binding重启恢复 |
| V2 | 多Root稳定调度 | blocker、Linear Priority、Root order、等待Human时切换Root、用户Tree调整 |
| V3 | Runtime与产品硬化 | 多Binding Desktop reconcile、错误可见性、打包升级、资源与rate-limit边界 |
| V4 | Provider扩展 | 在不改变Conductor/Linear模型的前提下启用新的Provider Backend |

V4只说明架构允许Provider扩展，不代表当前已经授权Claude或其他Provider产品功能。

## 3. V1目标

V1证明最小但完整的单Root模型：

```text
Podium Desktop Login Linear
-> select Project + Git repository + base branch
-> start one Conductor
-> create and login Codex Performer Profiles
-> activate one ready Profile
-> claim one delegated Root
-> create deterministic branch/worktree
-> Performer Plan Turn
-> create Workflow Tree
-> create Plan Approval Node with [Human Action] title prefix
-> approval
-> execute deepest ordered Work leaves
-> resolve Human leaves when encountered
-> Performer Root Gate
-> PR when gh works, otherwise branch
-> Root In Review
```

V1不追求多Root公平性、并行Turn或第二Provider。

## 4. V1功能边界

### Podium Desktop

- Linear OAuth登录和连接状态；
- Project catalog；
- 选择一个Project、local Git repository和base branch；
- 创建、启动、停止一个Conductor Binding；
- 检测该Conductor退出，并在旧process tree终止后按同一Binding重启；
- 提供Overview、Work、Conductors和Settings四个固定入口；
- 显示`NextActionView`、脱敏Conductor状态、Root状态和错误恢复说明；
- 创建/编辑多个Codex Performer Profiles；
- 通过Performer SDK完成ChatGPT登录或API Key登录；
- 无重启activate Profile；
- ChatGPT Profile可在SDK支持时配置Fast；API Key Profile显示Fast unavailable；
- 显示Total Tokens和Completed Roots；
- Plan Approval Node、Human回答和Root Done仍跳转到Linear完成。

### Podium

- `podium.db`保存credential、Project Catalog、Conductor Identity与Conductor Binding；
  Resolved Conductor Project由Conductor Project Label表达；
- 独占Linear SDK和Token refresh；
- 实现`LinearGatewayProtocolHandlerImpl`；
- 只转发Performer Profile Command和组合Profile/usage View，不持久化；
- 不解释Root Workflow。

### Conductor

- TypeScript daemon；
- 无任何数据库；
- 使用明文`profiles.json`保存多个`PerformerProfile`和active Profile ID；
- 为每个Profile分配独立`CODEX_HOME`，但不读取或修改其中Codex-owned文件；
- 通过`PerformerProfileControlInterface`启动SDK登录/status；
- full-read一个Root及其完整Tree；
- 每轮按`symphony:conductor/<short-hash>`解析当前Project；
- 维护一个Root Phase Label和一条Root Managed Comment；
- 使用Root Managed Comment和Work Managed Metadata中的覆盖式input hash识别内容变化；
- depth-first ordered leaf traversal；
- 每次一个Python Performer Turn；
- deterministic branch/worktree；
- Work commit、Root Gate和PR/branch交付；
- Desktop replacement启动后，Conductor从Linear和Git继续；
- 重启后从Linear、Git、Profile配置文件、`CODEX_HOME`和`performer_id`恢复。

### Performer

- Python process per Turn；
- 只启用`CodexBackendImpl`；
- 通过官方Codex Python SDK执行ChatGPT/API Key登录；
- 把model、reasoning和Fast映射为SDK public参数；
- 支持Plan、Work和Root Gate；
- 使用opaque `performer_id`继续Conversation；
- 无本地journal或任何数据库；
- 不调用Linear，不修改Git topology。

### Linear

- Root状态：Todo、In Progress、In Review、Done、Canceled；
- Root Phase Label：planning、awaiting-human、working、gating、delivering、in-review、blocked、failed；
- Work Nodes/Human Nodes都使用Sub Issue表达；
- Root Gate不创建Issue；
- Plan Approval Node使用受管Human Node表达；
- branch、PR、`performer_profile_id`、`performer_id`、usage和错误写Root Managed Comment；
- Work最新完成input hash写该Work Managed Metadata。

## 5. V1明确不做

- 多Root Priority/blocker调度；
- 多Performer并行；
- Plan Revision、Source Revision或Comment Revision；
- checkpoint、dispatch Queue、operation journal；
- Verification、Manifest、Evidence或Delivery Receipt；
- 非Git目录；
- 自动merge base branch；
- Web产品；
- 第二Provider；
- Profile加密或Podium Profile存储；
- Profile删除或修改既有Profile的登录方式；
- 跨Conductor共享Profile；
- 货币成本、ChatGPT credits或billing-grade usage；
- compatibility shim。

## 6. V1恢复边界

V1保证：

- Conductor process重启后可重读Linear/Git和Profile配置文件；
- Codex SDK可从每个Profile原`CODEX_HOME`恢复auth/session；
- 已保存`performer_id`时可继续同一Conversation；
- In Progress Work可以在新Turn中继续；
- worktree部分修改不会因Conductor重启丢失；
- Work commit、hash或state更新中断后可以重放或补齐；
- Canceled Work/subtree不会阻止Root Gate；
- metadata损坏时进入可恢复blocked，不静默视为完成；
- delivery阶段可按deterministic branch查找既有PR。

V1不保证：

- Python Performer process崩溃后旧Provider call仍继续运行；
- 操作系统或磁盘故障后的未落盘修改恢复；
- Provider无法通过ID resume时继续旧Conversation。

## 7. V1状态闭环

Performer Profile：

```text
readiness: login-required -> ready | invalid
selection: ready -> active
```

```text
Root Todo
-> Root In Progress + planning
-> awaiting-human
-> working
-> gating
-> delivering
-> Root In Review + in-review
-> user Done
```

异常：

```text
recoverable operator action -> blocked
terminal runtime failure     -> failed
user cancel                  -> Canceled
```

Work：

```text
Todo -> In Progress -> In Review -> Done
Todo | In Progress | In Review -> Canceled
```

Human：

```text
Todo -> In Progress -> Done | Canceled
Canceled -> In Progress when reopened
```

## 8. V1验收边界

V1架构只有在以下事实可被证明时才算闭环：

1. Linear Token只在Podium，Conductor通过Gateway完成Linear读写；
2. Conductor Project Label唯一解析到Resolved Conductor Project，Label变化后下个Turn边界切换Project；
3. 一个Root只产生一个Root Managed Comment、Root Phase Label、branch和worktree；
4. Plan生成的嵌套Tree与Linear parent/order一致；
5. 未批准Plan不会执行Work；
6. 用户新增或重排Sub Issue后，下一个Turn使用最新Tree；
7. Root title/description变化后重新Plan、reconcile未完成Work并重新批准；
8. Work Leaf title/description变化后只重跑该Work，不重做整棵Plan；
9. Performer中断后能以同一`performer_id`继续In Progress Work；
10. Root Gate失败创建一个Rework Work，成功才进入交付；
11. `gh`可用时创建或复用PR，不可用时清楚交付branch；
12. Root只进入In Review，不由Symphony自动Done；
13. Canceled Work和subtree不参与Root Gate；
14. In Review/Done Work缺少合法metadata时不会被静默视为完成；
15. 用户在Turn期间Done/Canceled Root后，旧Result不能推进；
16. Linear mutation precondition冲突后重新读取，不覆盖用户最新state；
17. Work commit/hash/state任一步中断后可以从Linear和Git收敛；
18. Conductor重启不依赖数据库；
19. Desktop可以创建多个Profile，ChatGPT/API Key登录只调用Codex SDK；
20. Symphony不读取或改写`auth.json`、`config.toml`；
21. activate Profile无需重启，新Root使用新Profile，已有Root保持原Profile；
22. model、reasoning和Fast在下一个Turn通过SDK参数生效；
23. API Key不进入Podium/Conductor自定义持久化或任何View/日志；
24. Desktop显示best-effort Token usage和Completed Roots。

## 9. V2：多Root调度

V2增加：

- 一个Conductor Binding内发现多个delegated Roots；
- unresolved Linear blocker优先阻止调度；
- eligible Roots按Linear Priority、Root order、identifier排序；
- 等Human的Root释放唯一Performer Turn；
- 每个Turn边界重读Priority、blocker和Tree顺序；
- dependency cycle和多In Progress冲突可见。

仍然不增加本地Queue、checkpoint、aging或ready sequence。

## 10. V3：Runtime与产品硬化

V3增加：

- Desktop启动时reconcile多个active Conductor Bindings；
- 多个Conductor Bindings各自保持恰好一个Conductor；
- 完整的错误、日志和named Desktop Views；
- Linear rate-limit与bounded polling；
- 打包升级、批量shutdown和多Conductor Binding crash replacement硬化；
- worktree清理和长期运行资源边界。

这些能力强化运行可靠性，不改变Linear-authoritative Workflow模型。

## 11. V4：Provider扩展

当第二Provider被明确授权时：

- 在Performer内部增加新的`ProviderBackendInterface`实现；
- 把Provider session/thread ID映射为同一个opaque `performer_id`；
- 继续使用相同Plan、Work、Root Gate Command/Result；
- 不修改Conductor调度、Linear Tree或Git交付模型。

若Provider不能可靠通过opaque ID恢复Conversation，则不接入，而不是为其重建Conductor数据库。

## 12. 不变量

1. 所有版本都保持Linear权威和Conductor无任何数据库。
2. V1先闭合单Root，V2再扩大到多Root。
3. Roadmap不授权未来Provider或Web实现。
4. 后续版本不能重新引入已删除的revision、receipt或operation模型。
