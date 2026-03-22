# Synapse 权限系统重构方案

基于当前仓库代码整理，目标是不考虑旧数据、旧表、旧接口兼容，直接给出一套可以替换现有权限系统的完整新方案。

当前分析主要参考这些位置：

- `packages/api/src/infrastructure/database/schema.sql`
- `docs/spicedb-schema.zed`
- `packages/api/src/infrastructure/authz/index.ts`
- `packages/api/src/infrastructure/middleware/auth.ts`
- `packages/api/src/infrastructure/middleware/workspace.ts`
- `packages/api/src/modules/workspace/*`
- `packages/api/src/modules/organization/*`
- `packages/api/src/modules/group/*`
- `packages/api/src/modules/memory/*`
- `packages/api/src/modules/capabilities/*`
- `packages/api/src/modules/skills/*`
- `packages/api/src/modules/mcp-plugins/*`
- `packages/api/src/modules/model-groups/*`
- `packages/api/src/modules/session/*`
- `packages/api/src/modules/automation/*`
- `packages/api/src/modules/files/*`
- `packages/api/src/modules/work-engine/*`
- `packages/api/src/modules/a2a/*`

## 1. 当前系统到底混乱在哪里

### 1.1 当前实际上有 5 套权限事实源

1. 身份认证
   `auth_sessions` + `authMiddleware`

2. 工作区成员关系
   `workspace_members.trust_level`

3. 平台和工作区角色
   `platform_user_roles`
   `workspace_member_roles`

4. 各领域对象自己的 grant 表
   `actor_grants`
   `conversation_grants`
   `conversation_memory_grants`
   `memory_grants`
   `model_group_grants`
   `capability_instance_grants`

5. SpiceDB / Authzed 图权限
   `docs/spicedb-schema.zed`
   `authz_outbox`
   `checkPermission`
   `lookupResources`

问题不在于“权限做得细”，而在于同一件事同时存在于数据库表、SpiceDB 关系、控制器 fallback 逻辑、service 内部 SQL 过滤里。

### 1.2 当前实体和权限模型的对应关系

| 领域 | 当前主要实体 | 当前权限来源 | 核心问题 |
| --- | --- | --- | --- |
| User / Auth | `users`, `auth_sessions` | session 认证 | 认证和授权分离不彻底，request 上只有 `userId`，没有统一 acting subject |
| Workspace | `workspace_members`, `workspace_member_roles` | trust_level + supplemental roles + SpiceDB workspace relation | 同时存在 trust_level、supplemental role、SpiceDB relation 三套表达 |
| Platform | `platform_user_roles` | 表 + SpiceDB | 和 workspace 的角色模型不统一 |
| Actor | `actors`, `actor_grants` | workspace role + actor grant + SpiceDB | Actor 同时是资源、主体、消息接收方、记忆 owner，职责过载 |
| Conversation | `conversations`, `conversation_members`, `conversation_grants`, `conversation_memory_grants` | 成员关系 + grant 表 + SpiceDB | 成员、权限、memory 权限被拆成多层 |
| Memory | `memory_entries`, `memory_grants` | owner_scope + grant_scope + SpiceDB | owner scope、grant scope、actor/conversation memory 权限重复表达 |
| Skill / Plugin | `capability_*`, `capability_instance_grants` | capability instance grant + SpiceDB + workspace guard | 数据模型已统一，权限模型没统一 |
| MCP Relay | `relay_devices`, `relay_exposures` | workspace manage_relays + relay 管理接口 | relay 既是基础设施，又被当成可执行能力来源，边界不清楚 |
| Model Config | `model_groups`, `model_profiles`, `model_group_grants` | owner_type + grants + SpiceDB | 所有权、可见性、可用性混在一起 |
| Secondary modules | `session`, `automation`, `files`, `work_engine`, `a2a` | auth only / workspace only / partial authz | 有些模块几乎没有对象级授权 |

### 1.3 当前最主要的结构性问题

#### 问题 A：权限入口太多

现在至少有这些入口在做权限判断：

- `workspaceMiddleware`
- 各 controller 内部的 `requireWorkspacePermission`
- 各 controller 内部的 `requireActorPermission`
- 各 controller 内部直接 `checkPermission`
- service 里再次按 SQL 过滤
- `lookupResources` 做列表过滤
- `authzEnabled()` 为 false 时的 fallback 逻辑

结果是同一个动作，比如“某用户是否能管理 plugin installation”，在不同模块中会有不同答案。

#### 问题 B：同一个概念在多个地方重复建模

典型重复：

- 工作区成员身份同时存在于：
  - `workspace_members`
  - SpiceDB `workspace#owner/admin/member/guest`
  - controller 的 `trust_level` fallback

- Actor 可调用性同时存在于：
  - `actor_grants`
  - SpiceDB `actor#invoke_*`
  - session/controller 的 membership fallback

- Memory 可见性同时存在于：
  - `owner_scope`
  - `memory_grants`
  - `conversation_memory_grants`
  - `actor_grants` 里的 `memory_*`
  - SpiceDB `memory`、`conversation`、`actor` 多层 relation

- Capability 可用性同时存在于：
  - `attachment_type`
  - `capability_instance_grants`
  - revision.authorization.requiredPermissions
  - SpiceDB `plugin_instance` / `skill_instance`

#### 问题 C：scope 概念爆炸，而且彼此不正交

当前系统至少有这些 scope：

- workspace / conversation / actor_global / actor_conversation / user
- workspace_user
- platform
- attachmentType
- ownerScope
- grantScope
- lifecycleScope
- reuseScope

这些 scope 混合了 4 种完全不同的语义：

1. 资源归属到哪里
2. 谁可以访问
3. 运行时实例复用边界
4. 记忆或能力的语义作用域

这是当前最核心的复杂度来源。

#### 问题 D：主体模型不干净

当前参与权限判断的“主体”有：

- user
- actor
- workspace_user 这种拼接上下文
- actor_conversation 这种拼接上下文

这说明系统缺少一个清晰的“运行时主体”建模。现在很多逻辑本质上在表达“某个 actor 在某个 conversation 里的运行身份”，但代码里是拿字符串拼 id。

#### 问题 E：插件权限和第三方 OAuth scope 混在一起

`capability_package_revisions.manifest.authorization.requiredPermissions` 当前被当成“谁能用这个 installation 的权限”，但它看上去更像“这个插件执行时需要的第三方授权能力”。

这两件事不应该是一个概念：

- “谁有权使用这个安装项”
- “这个安装项是否已经绑定了足够权限的外部账号”

当前 capability 体系把这两层揉在了一起。

#### 问题 F：存在明显的权限漏检和不一致

几个典型例子：

- `packages/api/src/modules/skills/controller.ts`
  只有 `authMiddleware + workspaceMiddleware`，大量接口没有对象级授权

- `packages/api/src/modules/capabilities/controller.ts`
  只有 workspace 级 preHandler，没有 grant 管理权限校验

- `packages/api/src/modules/automation/controller.ts`
  基本只有 `authMiddleware`

- `packages/api/src/modules/a2a/controller.ts`
  管理接口基本只有 `authMiddleware`

- `packages/api/src/modules/files/controller.ts`
  只要求是 workspace member

- `packages/api/src/modules/work-engine/controller.ts`
  只要求过了 `workspaceMiddleware`

这说明当前权限体系不是“有一套中心模型，然后局部未接入”，而是“每个模块都在局部发明自己的权限规则”。

## 2. 重构目标

新的权限系统必须满足 6 个目标：

1. 单一事实源
   只有一套授权模型，一套判断入口

2. 认证和授权分层
   `auth` 只负责确认你是谁
   `access` 只负责确认你能做什么

3. 主体模型清晰
   人类用户、Actor 运行时主体、系统应用主体分开

4. 资源模型清晰
   Actor、Conversation、Memory、Capability、Relay、Model 各自有明确边界

5. scope 语义拆分
   归属、可见性、运行时复用、秘密管理，分别建模

6. 所有 API 只走统一权限服务
   controller 里不再写散装 `checkPermission`

## 3. 新系统总设计

### 3.1 保留 SpiceDB，但把它升级为唯一授权事实源

建议保留 SpiceDB，不建议回退到纯 SQL ACL。

原因：

- 这个项目本质上是 ReBAC，不只是 RBAC
- `lookupResources` 对列表过滤很有价值
- Conversation、Actor、Capability、Model、Memory 都有对象级和关系级授权需求

但是要做两个硬性改变：

1. `authzEnabled()` 分支彻底删除
   新系统不允许“禁用 authz 时走另一套规则”

2. 所有权限判断统一走 `AccessService`
   业务代码不再直接调用 `checkPermission`

### 3.2 新的五层模型

新权限系统只保留下面五层概念：

1. Identity
   认证身份
   例如 `user`

2. Principal
   真正参与鉴权的主体
   例如 `user`、`actor_runtime`、`service_app`

3. Resource
   被访问的对象
   例如 `workspace`、`actor`、`conversation`、`memory_space`、`memory_item`、`capability_installation`

4. Role Binding
   把某个 principal 绑定到某个 resource 上的某个 role

5. Action
   对资源执行的具体动作

### 3.3 新的主体定义

建议把主体统一为 3 类：

#### 1. UserPrincipal

人类用户发起的 HTTP / WebSocket / 管理动作。

#### 2. ActorPrincipal

Actor 的全局主体，用于：

- actor 私有资源
- actor 级能力安装
- actor 级模型使用

#### 3. RuntimePrincipal

Actor 在某个具体对话上下文中的运行主体。

这层必须是正式模型，不能再用 `actorId|conversationId` 拼字符串。

建议直接基于 `conversation_members` 升级为真正的运行时主体：

- 用户在某个 conversation 中的 participant
- actor 在某个 conversation 中的 participant

即：

- `conversation_participant` 是正式资源，也是正式 principal
- `session` 只是执行实例，继承 participant 权限

这样可以替代当前的：

- `actor_conversation`
- 一部分 `workspace_user`

### 3.4 新的资源分类

#### Tenant 资源

- `platform`
- `workspace`

#### Collaboration 资源

- `actor`
- `conversation`
- `conversation_participant`
- `session`
- `automation_rule`
- `work_item`
- `a2a_app`

#### Knowledge 资源

- `memory_space`
- `memory_item`

#### Capability 资源

- `capability_package`
- `capability_installation`
- `credential_connection`

#### Infrastructure 资源

- `relay_device`
- `relay_exposure`

#### Model 资源

- `model_pool`
- `model_endpoint`

#### File 资源

- `file`

## 4. 统一后的权限语义

### 4.1 不再允许每个领域自己发明 grant_scope

新系统只允许下面两种 scope 语义：

#### 1. Parent / Ownership Scope

资源归属于谁，例如：

- actor 属于 workspace
- conversation 属于 workspace
- memory_space 属于 workspace / conversation / actor / participant / user
- capability_installation 绑定到 workspace / conversation / actor / participant / user
- model_pool 属于 platform / workspace / user

#### 2. Runtime Lease Scope

只控制实例复用，不参与授权，例如：

- turn
- session
- conversation
- workspace
- actor
- user

这意味着：

- `attachment_type` 保留，但只表达“安装绑定到哪里”
- `reuse_scope` 保留，但只表达“实例如何复用”
- 不再存在 capability 自己的 grant_scope 枚举
- 不再存在 memory 自己的 owner_scope + grant_scope 双系统

### 4.2 Memory 重构为 Space + Item

这是整个系统最值得重构的一块。

当前 Memory 的复杂度来自：

- `memory_entries.owner_scope`
- `memory_grants`
- `conversation_memory_grants`
- `actor_grants.memory_*`

建议改成：

#### `memory_spaces`

空间类型只保留：

- `workspace_shared`
- `conversation_shared`
- `actor_private`
- `participant_private`
- `user_private`

每条 memory item 只属于一个 `memory_space`。

#### `memory_items`

只保存内容、索引、来源、状态，不再自己带 grant。

#### Memory 的产品心智模型

对用户只保留一条规则：

- Memory 放在哪条路径下，就决定它能被哪个范围读取
- 把 Memory 移动到别的路径，就是修改可见范围
- Memory 自己不再携带额外 grant
- 需要更大范围共享时，移动到更高层路径，或者复制到另一条路径

前端不再暴露 “grant memory” 这类动作，只暴露路径选择和移动。

#### Memory 权限只作用在 space 上

角色建议：

- `reader`
- `writer`
- `manager`

动作建议：

- `memory_space.read`
- `memory_space.write`
- `memory_space.manage`
- `memory_item.delete`

默认规则：

- `workspace_shared`
  workspace member 可读
  memory_admin / workspace_admin 可管理

- `conversation_shared`
  conversation participant 可读
  conversation manager / moderator 可写或管理

- `actor_private`
  actor principal 可读写
  actor owner / editor 可管理

- `participant_private`
  对应的 runtime principal 可读写
  conversation manager 可管理

- `user_private`
  user 自己可读写
  不默认暴露给 actor

这样可以直接删除：

- `memory_grants`
- `conversation_memory_grants`
- `actor_grants` 里的 `memory_*`

### 4.3 Skill / Plugin 统一为 Capability Installation

当前数据层其实已经走到一半了，`capability_packages` / `capability_instances` 已经在统一，但权限层还没统一。

新方案：

#### Capability 分两层

1. `capability_package`
   Marketplace / Registry 里的包

2. `capability_installation`
   某个 workspace / conversation / actor / participant / user 上的安装项

Skill 和 Plugin 只是 `package.kind` 不同，不再有两套权限系统。

#### Installation 角色

- `viewer`
- `user`
- `operator`
- `manager`

对应动作：

- `capability.read`
- `capability.use`
- `capability.configure`
- `capability.grant`
- `capability.delete`

#### 第三方授权单独抽成 `credential_connection`

把现在 revision 里 `authorization.requiredPermissions` 改成下面两层：

1. `required_credential_scopes`
   第三方 OAuth / API scope

2. `required_runtime_capabilities`
   安装项执行时需要的宿主能力

然后新增资源：

- `credential_connection`

角色：

- `owner`
- `consumer`
- `manager`

动作：

- `credential.read_metadata`
- `credential.use_secret`
- `credential.rotate`
- `credential.delete`

运行插件时，必须同时满足：

1. runtime principal 对 `capability_installation` 有 `use`
2. installation 绑定的 credential 对运行主体有 `use_secret`

这样就彻底拆开了：

- “谁能用这个安装项”
- “这个安装项现在有没有足够的外部账号权限”

### 4.4 Actor 权限收缩到真正属于 Actor 的事情

当前 `actor_grants` 同时控制：

- discover
- invoke
- receive_message
- memory_read
- memory_edit
- memory_grant
- memory_retarget
- memory_delete

这太多了。

新方案 Actor 只保留：

- `actor.read`
- `actor.invoke`
- `actor.edit`
- `actor.delete`
- `actor.grant`

如果涉及 memory，走 memory_space。

如果涉及 conversation 中的收信/发言，走 conversation participant 或 conversation role。

如果涉及 plugin/model use，走 capability/model 资源本身。

即：Actor 不再成为所有子系统的权限代理。

### 4.5 Conversation 权限收敛为参与者模型

Conversation 只保留一张参与者模型：

- `conversation_participants`
  - participant role: `member`, `moderator`, `manager`
  - participant state: `active`, `left`, `removed`, `blocked`

Conversation 动作建议：

- `conversation.read`
- `conversation.send`
- `conversation.manage`
- `conversation.manage_participants`
- `conversation.attach_files`
- `conversation.moderate`

默认规则：

- `member` -> read, send
- `moderator` -> read, send, moderate, attach_files
- `manager` -> 全部

这样可以删除：

- `conversation_grants`
- 额外的 `sender/member_manager/resource_attacher` 这种细碎 relation 设计

如果未来需要例外授权，也统一走 `resource_role_bindings`，而不是再做专门 grant 表。

### 4.6 Model Config 重构为 Pool + Endpoint

当前 `model_groups` / `model_profiles` / `model_group_grants` 也把很多东西混在一起。

建议改成：

#### `model_endpoints`

真正的 provider endpoint 和 secret，例如：

- provider_type
- base_url
- model_name
- api_key
- timeout/retry

#### `model_pools`

逻辑路由层，定义：

- 候选 endpoint 列表
- 路由策略
- fallback 策略

#### `actor_model_bindings`

Actor 绑定到哪个 `model_pool`

#### `model_pool_role_bindings`

角色：

- `consumer`
- `editor`
- `manager`

动作：

- `model_pool.use`
- `model_pool.edit`
- `model_pool.grant`
- `model_pool.delete`

#### Endpoint secret 单独保护

`model_endpoint` 只有管理员能：

- `model_endpoint.read_secret`
- `model_endpoint.edit_secret`

普通用户和 Actor 永远不直接接触 endpoint secret。

### 4.7 MCP Relay 只做基础设施，不直接承担用户授权语义

Relay 当前的问题是：

- 一方面它是设备和暴露工具
- 另一方面它又被当成用户可以直接使用的能力来源

建议切开：

#### Relay 层只负责

- 设备配对
- 设备信任
- 暴露发现
- 工具 catalog 同步

资源：

- `relay_device`
- `relay_exposure`

动作：

- `relay_device.read`
- `relay_device.manage`
- `relay_device.trust`
- `relay_device.delete`
- `relay_exposure.read`
- `relay_exposure.bind`

#### 最终给用户使用的，仍然是 `capability_installation`

也就是说：

- relay exposure 发现工具
- 生成或更新 capability package / installation
- 最终的 use 权限，仍由 capability 系统控制

这样可以避免“relay 权限”和“plugin 权限”并行。

## 5. 新的数据结构建议

### 5.1 删除的表

直接删除：

- `platform_user_roles`
- `workspace_member_roles`
- `actor_grants`
- `conversation_grants`
- `conversation_memory_grants`
- `memory_grants`
- `model_group_grants`
- `capability_instance_grants`

`workspace_members` 可以保留，但建议升级为统一角色绑定模型。

### 5.2 新表建议

#### 1. 平台 / 工作区角色绑定

`platform_role_bindings`

- id
- user_id
- role_key
- granted_by
- created_at
- revoked_at
- metadata

`workspace_role_bindings`

- id
- workspace_id
- user_id
- role_key
- granted_by
- created_at
- revoked_at
- metadata

#### 2. 通用资源角色绑定

`resource_role_bindings`

- id
- resource_type
- resource_id
- subject_type
- subject_id
- role_key
- granted_by_subject_type
- granted_by_subject_id
- created_at
- revoked_at
- metadata

这张表替代现在所有对象级 grant 表。

#### 3. 对话参与者

`conversation_participants`

- id
- conversation_id
- principal_type
- principal_id
- role_key
- state
- joined_at
- left_at
- metadata

这张表替代当前 `conversation_members`，并直接承担 conversation 里的角色语义。

#### 4. Memory

`memory_spaces`

- id
- workspace_id
- space_type
- owner_resource_type
- owner_resource_id
- title
- metadata
- created_at
- updated_at

`memory_items`

- id
- space_id
- category
- status
- stability
- importance
- confidence
- tags
- text_digest
- search_text
- source_item_id
- source_tool_call_id
- source_turn_id
- supersedes_memory_id
- metadata
- created_at
- updated_at

`memory_item_parts`

- item_id
- ordinal
- part_type
- ...

#### 5. Capability

`capability_packages`

- 保留

`capability_revisions`

- 保留，但把 `authorization.requiredPermissions` 改名并拆义

`capability_installations`

- 保留，但 attachment type 改为：
  - `workspace`
  - `conversation`
  - `actor`
  - `conversation_participant`
  - `user`

`credential_connections`

- id
- workspace_id
- owner_user_id
- provider_key
- external_account_id
- scopes
- secret_blob
- metadata
- created_at
- updated_at

`capability_installation_credentials`

- installation_id
- credential_id
- purpose

#### 6. Model

`model_endpoints`

- id
- owner_type
- owner_workspace_id
- owner_user_id
- provider_type
- base_url
- model_name
- api_key
- timeout/retry
- metadata

`model_pools`

- id
- owner_type
- owner_workspace_id
- owner_user_id
- name
- routing_strategy
- attempt_policy
- is_default
- is_enabled
- metadata

`model_pool_endpoints`

- pool_id
- endpoint_id
- priority
- weight
- is_enabled

`actor_model_bindings`

- actor_id
- pool_id
- priority

#### 7. Relay

`relay_devices`

- 保留

`relay_exposures`

- 保留

但用户侧不再给 relay 做单独安装授权表。

## 6. 新的角色体系

### 6.1 平台角色

建议保留固定角色，不开放自定义：

- `platform_owner`
- `platform_admin`
- `platform_catalog_admin`
- `platform_model_admin`
- `platform_support`
- `platform_auditor`

### 6.2 工作区角色

建议固定角色：

- `workspace_owner`
- `workspace_admin`
- `workspace_member`
- `workspace_guest`
- `workspace_actor_admin`
- `workspace_conversation_admin`
- `workspace_memory_admin`
- `workspace_capability_admin`
- `workspace_model_admin`
- `workspace_relay_admin`

这些角色全部进入统一 role catalog，由代码定义 action bundle。

### 6.3 资源级角色

#### Actor

- `owner`
- `editor`
- `invoker`
- `viewer`

#### Conversation

- `manager`
- `moderator`
- `member`

#### MemorySpace

- `manager`
- `writer`
- `reader`

#### CapabilityInstallation

- `manager`
- `operator`
- `user`
- `viewer`

#### ModelPool

- `manager`
- `editor`
- `consumer`

#### RelayDevice

- `owner`
- `operator`
- `viewer`

## 7. 新的代码结构

### 7.1 新模块：`modules/access`

建议新增统一权限模块：

- `modules/access/actions.ts`
  所有 action 常量和类型

- `modules/access/resources.ts`
  所有 resource ref 定义

- `modules/access/role-catalog.ts`
  平台角色、工作区角色、资源角色的 action bundle

- `modules/access/context.ts`
  从 request / session / conversation participant 解析 acting principal

- `modules/access/service.ts`
  统一封装：
  - `authorize`
  - `authorizeOrThrow`
  - `listAuthorizedResources`
  - `syncBindings`

- `modules/access/guards.ts`
  Fastify 可复用 guard

- `modules/access/projection.ts`
  DB 角色绑定到 SpiceDB relation 的唯一投影器

### 7.2 controller 只做两件事

1. 解析参数
2. 调 `AccessService.authorizeOrThrow`

controller 不再：

- 自己查 `workspace_members`
- 自己查 `trust_level`
- 自己拼装 `checkPermission`
- 自己决定 fallback 逻辑

### 7.3 service 不再直连 Authzed SDK

业务 service 一律不直接 import：

- `checkPermission`
- `lookupResources`
- `authzEnabled`

全部通过 `AccessService` 或对应 repository 间接调用。

### 7.4 middleware 职责收缩

`authMiddleware`

- 只负责认证

`workspaceMiddleware`

- 只负责加载 workspace 基础信息
- 不再做授权

因为授权必须按 action + resource 来判断，不能在 middleware 层靠 `workspaceId` 粗暴放行。

## 8. 新的 API 判断方式

### 8.1 用户请求

```ts
const access = await accessService.fromRequest(request)

await access.require({
  action: 'actor.invoke',
  resource: { type: 'actor', id: actorId },
})
```

### 8.2 运行时请求

```ts
const access = await accessService.fromRuntime({
  sessionId,
  participantId,
  actorId,
})

await access.require({
  action: 'capability.use',
  resource: { type: 'capability_installation', id: installationId },
})
```

### 8.3 列表过滤

```ts
const actorIds = await access.listAuthorizedResourceIds({
  action: 'actor.read',
  resourceType: 'actor',
})
```

而不是在每个 service 里：

- 先 `lookupResources`
- 再自己按 SQL grants 重算一遍

## 9. 各领域的具体重构建议

### 9.1 Workspace

保留：

- workspace 本身
- invite

重做：

- 所有成员和角色统一到 role binding
- `trust_level` 改为正式 role key，不再单独存在

### 9.2 Actor

保留：

- actor
- actor_version
- actor_template

删除：

- `actor_grants`
- Actor 上的 memory 权限代理职责

新增：

- actor resource role binding

### 9.3 Conversation

保留：

- conversation
- session
- turn
- conversation items

重做：

- `conversation_members` -> `conversation_participants`
- `conversation_grants` 删除
- `conversation_memory_grants` 删除

### 9.4 Memory

彻底改造成：

- `memory_spaces`
- `memory_items`
- `memory_item_parts`

产品规则：

- 路径就是可见范围
- 移动路径就是修改可见范围
- 不再允许单条 memory 例外授权

删除：

- `owner_scope`
- `memory_grants`

### 9.5 Skill / Plugin / Capability

保留：

- package / revision / asset / installation

重做：

- installation 角色模型
- credential connection 资源
- 安装 use 权限和外部凭据 scope 拆开

删除：

- `capability_instance_grants`
- controller 里的散装 workspace 兜底

### 9.6 Model Config

保留逻辑概念：

- pool
- endpoint

删除：

- `model_group_grants`

新增：

- model pool role binding
- endpoint secret action

### 9.7 MCP Relay

保留：

- device / exposure / catalog / tool

重做：

- relay 只承担基础设施权限
- 终端用户用到的工具，全部通过 capability installation 暴露

### 9.8 Secondary modules

这些模块都要接入统一权限：

- `session`
- `files`
- `automation`
- `work-engine`
- `a2a`

否则主系统再干净，这些旁路模块照样会把权限打穿。

## 10. 实施顺序

既然不考虑兼容旧接口和旧表，建议直接按大版本重写，不要做新旧双轨。

### Phase 1：先搭地基

1. 新建 `modules/access`
2. 确定 action 常量、resource 类型、role catalog
3. 重写 SpiceDB schema
4. 建新 binding 表
5. 删除 `authzEnabled` 逻辑分支

### Phase 2：重写核心协作域

1. workspace
2. actor
3. conversation
4. session

这四块是全系统权限的骨架。

### Phase 3：重写 memory

1. 引入 `memory_spaces`
2. 改写 memory search / recall / write
3. 删除所有 memory 相关 grant 表和 actor memory 权限

### Phase 4：重写 capability / credential / relay

1. capability installation 角色模型
2. credential connection
3. relay 和 capability 解耦

### Phase 5：重写 model

1. model pool / endpoint
2. actor model binding
3. pool use / endpoint secret 分离

### Phase 6：补齐所有旁路模块

1. standing orders
2. files
3. work engine
4. a2a

### Phase 7：删旧代码

删除：

- 所有 `*_grants` 旧表
- 所有 fallback `trust_level` 判断
- 所有 controller 内自定义 `require*Permission`
- 所有 service 里直接 `checkPermission` / `lookupResources`
- 所有拼接式上下文 id

## 11. 我建议的几个硬规则

这几条如果不执行，重构最后还会再次长成现在这样。

### 规则 1

任何模块都不允许直接 import Authzed SDK。

### 规则 2

任何 controller 都不允许直接查 `workspace_members` 判断权限。

### 规则 3

任何权限动作都必须是 typed action，不能传自由字符串。

### 规则 4

任何运行时主体都必须是正式 resource 或 principal，不能拼接临时 id。

### 规则 5

任何“外部凭据可用性”都不能和“本地资源使用权限”混为一谈。

## 12. 最终结论

如果只做局部修补，比如：

- 给某几个 controller 补几个 `checkPermission`
- 再加一张 grant 表
- 再加一个 scope 枚举

系统只会更乱。

这次重构应该直接做成下面这个形态：

1. SpiceDB 是唯一授权事实源
2. `AccessService` 是唯一授权入口
3. `conversation_participant` 是正式运行时主体
4. Memory 改成 `space + item`
5. Skill / Plugin / Relay 全部收敛到统一 capability 模型
6. Model 的 use 权限和 endpoint secret 权限分离
7. 删除所有按领域复制出来的 grant 表

如果按这个方向落地，整个项目的权限系统会从“每个模块自己发明一套规则”，收敛成“统一主体、统一资源、统一动作、统一绑定、统一授权入口”的结构。
