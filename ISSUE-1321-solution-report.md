# TencentDB-Agent-Memory Issue #1321 分析与解决报告

> 分析日期：2026-09-19  
> 分析对象：[Issue #1321](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/1321)  
> 目标分支：`feat/server_team`  
> 当前状态：Issue 仍为 Open；关联 PR #1323、#1398、#1442 均为 Open

## 1. 结论

该问题是资源生命周期、授权模型和跨模块级联三个缺陷叠加造成的高风险数据一致性问题：系统先删除团队成员关系或用户身份，使 Agent 的 `owner_user_id` 失去有效主体；随后 Agent 删除接口仍执行 owner-only 校验，导致 team admin 和 system admin 也无法回收该 Agent。

建议以 [PR #1442](https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/1442) 为短期修复基线，但合并前需要维护者完成代码审查与 CI。它正确覆盖了两个容易产生严重回归的边界：

1. 移除团队成员时必须按 `team_id + owner_user_id` 查询，不能误删该用户在其他团队的 Agent；
2. Agent 数量超过单页上限时必须完整分页，不能只删除前 100/1000 条。

不过，#1442 只能解决 metadata 层的孤儿 Agent 和绑定残留，不能完整清理 SkillCore 中的 active skill，也不能清理 chat memory 的真实 L0-L3/向量内容。其多步级联也没有事务保护。因此建议将修复分为两期：第一期消除不可删除 Agent 并修复权限一致性；第二期增加跨服务生命周期编排、幂等重试和存量 GC。

## 2. 现象与影响

典型触发链路如下：

```text
添加成员
  -> Panel 异步克隆默认 Agent
  -> Agent.owner_user_id = member.user_id

移除成员 / 删除用户
  -> 只删除成员关系或用户凭证
  -> Agent 仍保留原 owner_user_id
  -> owner 已不在团队或无法再认证

删除 Agent
  -> delete/archive 只允许 owner
  -> team admin / system admin 被拒绝
  -> 返回 403 NOT_YOUR_AGENT
```

直接影响：

- 孤儿 Agent 长期占用 metadata 和关联资源；
- Panel 对 team admin 显示删除按钮，但后端返回 403；
- `meta_task_agents`、`meta_agent_fixed_assets`、chat-memory 资产可能残留；
- Agent 名下 skill 也可能因 owner-only 校验无法删除；
- 存量异常只能由运维使用高权限 token 手工处理，且容易漏删或误删。

风险等级建议定为 **P1 / High**。它同时涉及权限绕过缺失、不可恢复数据、跨团队误删风险和长期脏数据积累。

## 3. 根因分析

### 3.1 成员生命周期不对称

添加成员后，Panel 会通过 `cloneDefaultAgentForNewMember` 创建默认 Agent；但 `removeTeamMemberForCaller()` 只删除 `meta_team_members` 关系，没有在删除前处理该成员在当前团队下的 Agent。

这破坏了一个关键不变量：

```text
active Agent.owner_user_id
  必须对应有效用户，且该用户必须具备与 Agent.team_id 一致的有效归属关系，
  或系统必须存在明确的托管/转移状态。
```

### 3.2 用户删除未处理拥有的 Agent

用户删除会清理 user key、团队成员关系和 ACL，却不清理 `meta_agents`。一旦 user key 被删除，原 owner 无法再认证，而 owner-only 删除策略仍要求该主体发起请求，形成永久死锁。

### 3.3 授权策略在层间不一致

- Panel 的 `canManageAsset` 对 team admin 返回 true；
- Panel `agent/delete-cascade` 和 MemoryCore 的 delete/archive 路径却执行 owner-only；
- `ctx.isSystemAdmin` 已由认证层解析，但删除/归档未使用；
- 已存在的 `assertCallerIsAgentOwnerOrTeamAdmin` helper 没有复用于生命周期接口。

结果是前端能力展示、控制层鉴权和内核鉴权三个权限面不一致。

### 3.4 团队删除绕过统一级联入口

SQLite 和 MongoDB 的 `deleteTeams()` 直接删除 `meta_agents`，绕过 `deleteAgents()`，所以 Agent 的 task/fixed-assets/chat-memory metadata 绑定不会被统一清理。

### 3.5 缺少可恢复的生命周期机制

系统没有 ownership transfer、托管 owner、墓碑状态、后台 GC 或跨服务补偿机制。任何一步失败都可能留下部分删除状态。

## 4. 关联 PR 评估

| PR | 覆盖范围 | 测试/评审状态 | 评价 |
|---|---|---|---|
| [#1323](https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/1323) | 成员/用户级联、admin delete/archive、Panel 路径、SQLite/MongoDB team delete | Open，8 commits；描述含 SQLite 冒烟和容器端到端验证，但无正式 review | 方案较完整，可作为实现参考；提交历史较多，需确认最新分支是否包含分页和跨团队用例 |
| [#1398](https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/1398) | 成员/用户级联、admin delete/archive | Open，1 commit，未加单测；review 已 Request changes | **不建议合并**。review 证实 team 过滤未生效，会跨团队误删；固定 `limit=1000` 会漏删 |
| [#1442](https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/1442) | 完整级联、admin 权限、Panel、SQLite/MongoDB、分页和契约测试 | Open，1 commit；0 checks、暂无 review；作者报告 69 tests passed、Panel typecheck 通过 | 当前最佳基线；仍需维护者 review、正式 CI、MongoDB 实测和跨服务清理方案 |

PR #1398 的两个 P1 评审结论尤其重要：

- `listAgentsByOwner(..., { team_id })` 的过滤对象并不支持 `team_id`，SQLite/MongoDB adapter 均会忽略该字段；
- 固定读取一页会让超出上限的 Agent 继续成为孤儿。

#1442 使用 `listAgentsByTeam(teamId, pagination, { owner_user_id })` 处理成员移除，并循环分页收集 ID，方向正确。

## 5. 推荐实现

### 5.1 统一授权模型

生命周期操作应明确采用以下矩阵，并让 UI、Panel 和 MemoryCore 共用同一语义：

| 操作主体 | 删除自己的 Agent | 删除同团队成员 Agent | 删除任意团队 Agent |
|---|---:|---:|---:|
| owner | 允许 | 否 | 否 |
| team admin | 允许 | 允许 | 否 |
| system admin | 允许 | 允许 | 允许 |
| 普通无关用户 | 否 | 否 | 否 |

MemoryCore 的 `deleteAgentsForCaller()` 和 `archiveAgentForCaller()` 应统一调用 `assertCallerIsAgentOwnerOrTeamAdmin()`，并在 helper 内显式放行 `ctx.isSystemAdmin`。前端只根据同一权限矩阵展示操作入口。

### 5.2 在破坏 owner 可达性之前处理 Agent

执行顺序必须为：

```text
验证调用者权限
  -> 收集目标 Agent ID（完整分页）
  -> 删除/归档 Agent 及 metadata 关联
  -> 删除成员关系或用户
```

成员移除只处理指定团队：

```ts
listAgentsByTeam(teamId, page, { owner_user_id: userId })
```

用户删除处理该用户跨所有团队的 Agent：

```ts
listAgentsByOwner(userId, page)
```

不要在逐页查询过程中边删边使用 offset 翻页，否则集合缩短会跳过记录。应先完整收集稳定的 Agent ID，再批量删除；数据量很大时改用基于稳定主键的 keyset pagination。

### 5.3 所有入口复用 `deleteAgents()`

`deleteTeams()`、成员移除和用户删除都应复用 `deleteAgents()`，禁止 raw SQL / `deleteMany(meta_agents)` 直接删除 Agent。团队删除时顺序为：

```text
收集团队 Agent
  -> deleteAgents(agentIds)
  -> 删除团队 assets/tasks/members
  -> 删除 team
```

先删除团队资产会让 `deleteAssets()` 因目标已不存在而幂等返回，其他 Agent 对这些资产的借入绑定将无法定位和清理。

### 5.4 区分 owner 与 admin 删除路径

短期可沿用 #1442：

- owner：列出并删除 skill，然后 archive Agent；
- team/system admin：调用内核 `agent/delete` 硬删除 metadata，避免 owner 已失效时再次被 skill/delete 阻断。

但这只是降级方案。admin 路径会留下 SkillCore 中的 active skill，因此第二期应增加受控的服务端接口，例如：

```text
SkillCore.adminDeleteByAgent(agentId, lifecycleOperationId)
ChatMemory.adminPurgeByAgent(agentId, lifecycleOperationId)
```

接口必须进行服务间认证、记录审计日志并支持幂等重试，不应通过冒充 owner 或读取 owner key 实现。

### 5.5 引入可恢复的删除编排

推荐将跨服务删除建模为生命周期作业：

```text
ACTIVE -> DELETING -> DELETED
                 \-> DELETE_FAILED（可重试）
```

metadata 数据库内用事务完成状态变更与 outbox 写入；后台 worker 按 `operation_id` 清理 SkillCore、ChatMemory 和向量存储。所有下游删除接口幂等。完成后再物理删除 metadata，失败时保留可观测状态和重试入口。

这能避免同步级联中任一步超时导致“Agent 已删、成员仍在”或“用户已删、外部内容仍在”的半完成状态。

## 6. 存量数据修复

上线修复前先做只读审计，至少识别三类异常：

1. `meta_agents.owner_user_id` 对应用户不存在；
2. owner 存在，但不是 `agent.team_id` 的 active member；
3. Agent 已不存在，但 task/fixed-assets/skill/chat-memory 仍引用该 Agent。

修复工具应支持 `--dry-run`、分页、批次大小、审计输出和幂等重跑。每条记录根据业务策略选择：

- 能确认是自动克隆的默认 Agent：硬删除并清理所有关联；
- 有用户数据价值：转移给 team owner 或 system custody account，再由管理员确认；
- owner 仅暂时离开团队：归档并进入保留期，避免直接造成不可逆数据丢失。

不要直接批量执行 `DELETE FROM meta_agents`。存量修复也必须经过统一生命周期入口。

## 7. 测试与验收清单

合并门槛建议包含：

- 移除成员只删除其在目标团队的 Agent，不影响同一用户在其他团队的 Agent；
- 删除用户清理其跨团队全部 Agent；
- Agent 数量为 0、1、分页边界、边界 + 1、多页时结果一致；
- owner、team admin、system admin、普通用户四类权限全部覆盖 delete 和 archive；
- SQLite 与 MongoDB 使用同一份 store contract；
- team delete 清理 Agent、task-agent、fixed-assets、chat-memory metadata 及跨团队借入绑定；
- SkillCore 开启/关闭、超时、部分失败时行为可恢复；
- ChatMemory 内容与向量数据实际删除，不只验证 metadata 资产行；
- 重复调用删除接口返回幂等结果；
- 并发创建 Agent 与移除成员/删除用户时，不产生新孤儿；
- Panel 的按钮可见性与后端权限矩阵一致；
- 所有破坏性管理员操作有 actor、target、team、operation ID 和结果审计。

## 8. 发布建议

1. 先合入第一期修复，并在 CI 中同时跑 SQLite contract、MongoDB integration、MemoryCore service tests 和 Panel typecheck；
2. 部署后运行只读 orphan scanner，记录基线数量；
3. 小批量执行存量修复，核对删除/转移结果和审计日志；
4. 观察 403 `NOT_YOUR_AGENT`、`DELETE_FAILED`、孤儿计数及外部内容清理积压；
5. 完成 SkillCore/ChatMemory 管理员级联接口后，再宣布 Issue 全面关闭。

## 9. 本工作区已实施的修复

本地代码已吸收上述第一期修复，主要改动如下：

- `MemoryCore/src/metadata/service/metadata-service.ts`：删除用户、移除成员和删除团队前先完整分页收集 Agent，再经统一 `deleteAgents()` 级联；成员移除按 `team_id + owner_user_id` 隔离；接入可选 ChatMemory 内容清理器；delete/archive 统一支持 owner、team admin 和 system admin。
- `MemoryCore/src/metadata/store/sqlite-adapter.ts`、`mongodb-adapter.ts`：团队删除改为先走 Agent 级联入口，移除绕过级联的 `meta_agents` 直接删除。
- `MemoryPanel/src/panel/http/routes/agent-lifecycle.ts`：`agent/delete-cascade` 增加 team admin/system admin 权限；管理员路径直接执行内核删除以处理失效 owner，owner 路径继续清理 skill 后归档，并返回 `mode`。
- 新增 metadata service orphan-agent 测试、SQLite contract runner，并扩展 store contract 覆盖团队级联和跨团队借入绑定清理。

分页采用每页 100 条，先收集稳定 ID 再删除，避免边删边用 offset 导致跳过记录。

## 10. 验证结果

已尝试运行：

```text
pnpm exec vitest run src/metadata/service/metadata-service-orphan-agent.test.ts src/metadata/store/sqlite-metadata-store.test.ts
```

由于当前环境的 pnpm 依赖安装未完成，命令持续尝试从 npm registry 下载缺失包并出现 `EACCES`，无法启动 Vitest；该测试结果不能视为通过。`tsc --noEmit` 和 MemoryPanel typecheck 也因同一依赖未完成而未能执行。新增测试文件和 contract 断言已随源码提交，CI 应在完整依赖环境中运行。

## 11. 最终判定

当前工作区已完成 Issue #1321 第一阶段的代码修复，覆盖孤儿 Agent、跨团队隔离、完整分页、管理员权限和 SQLite/MongoDB 统一级联。由于依赖环境未能启动测试，合并前仍需在 CI 完整执行新增测试、store contract、MongoDB integration 和 Panel typecheck。active skill 残留、真实记忆内容清理依赖注入、非事务级联仍是后续生产闭环项，并应配套可审计、幂等的存量修复工具。

## 12. 证据来源与范围

- [Issue #1321](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/1321)：问题描述、复现、维护者验收要求和已知限制；
- [PR #1323](https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/1323)：较完整的早期实现和手工验证记录；
- [PR #1398](https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/1398)：候选实现及针对跨团队误删、分页漏删的 P1 review；
- [PR #1442](https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/1442)：当前推荐基线、代码 diff、测试说明和已知限制。

本报告基于 2026-09-19 GitHub 页面、公开 diff 以及当前工作区源码审查。当前目录为解压后的源码副本，没有 `.git` 元数据；本地验证受 npm registry 依赖下载权限阻塞，未把未执行的检查标记为通过。
