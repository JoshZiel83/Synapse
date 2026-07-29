# 更新日志

[English](./CHANGELOG.md) · **简体中文** · [Español](./CHANGELOG_ES.md)

本文件记录本项目所有值得关注的变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，本项目力求遵循
[语义化版本](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。

> [!WARNING]
> Synapse 仍处于早期设计与实现阶段（pre-1.0）。按 SemVer 的 0.x 规则，任何版本都可能包含
> 破坏性变更，且目前不承诺兼容旧数据——破坏性变更通过重建数据库（`npm run db:rebuild`）并
> 重新部署来处理，而非迁移（见 [`deploy.md`](./deploy.md)）。在 `0.x` 阶段，**次版本号**
> 递增（`0.Y.0`）表示破坏了某个面向使用方的接口（REST/WebSocket 路由与 DTO、设备协议的
> wire 格式、`@synapse/shared` 导出、认证，或移除了某项能力），**修订号**递增（`0.y.Z`）
> 则保持向后兼容。下方 `0.27.0` 及更早的带标签版本是对 `dev` 线历史的追溯性重建，其间各包
> manifest 一直保持 `0.1.0`；`0.28.0` 是首个发布到包注册表的版本，自此各包 manifest 开始
> 记录已发布的版本号。

## [Unreleased]

## [0.29.1] - 2026-07-25

配置新增了一层基于文件、经 schema 校验的入口，工作文档则撤出对外发布的仓库。wire 契约与数据库 schema 均无变更，故本次发布无需 `db:rebuild`。

### 新增

- 一条 Zod→JSON-Schema 生成流水线：`npm run schema:gen` 从 Zod 定义生成 `/schemas/*.schema.json`（draft-07）；`verify:boundary` 中新增 `guard:schemas` 门控，已提交的 schema 一旦偏离其来源即令 CI 失败；首次加入的 `.vscode` 设置把这些 schema 接入 YAML/JSON 编辑，随仓库收录的第三方 schema 收在 `schemas/vendor/` 下。
- `CONTENT_STORAGE_BACKENDS_FILE`：内容存储后端注册表现在可以从 JSON 文件加载。与内联的 `CONTENT_STORAGE_BACKENDS` 环境变量互斥——两者同时设置会在启动时报错。
- `runtime-tuning.json`（路径由 `RUNTIME_TUNING_CONFIG_PATH` 指定）：面向记忆召回与实时发件箱的十三个可调参数，启动时经 schema 校验。
- 设备运行时自带的 `cli-prereq-overlay.json` 现在在加载时得到真正的校验——此前只是一次未经检查的类型断言，畸形的 overlay 会静默地让 CLI 门控出错——另为工具链 manifest 补上了 schema。

### 变更

- `CONTENT_STORAGE_BACKENDS` 的 s3 条目改为严格校验：未知或拼写错误的键此前被静默忽略，现在会在启动时报错。配置正确者不受影响。
- daemon 的下一 turn 派发改走结构化的 `detach()` 路径，以满足 trace guard（行为无变化）。

### 移除

- 六份遗留的设计/提示词文档移出了受跟踪的目录树；工作文档现在放在仅限本地、已被 gitignore 的 `.docs/` 目录下，不再随仓库发布。

## [0.29.0] - 2026-07-24

分布式追踪 round-3 至此收官：v0.28.0 引入时还是可选的 `turn_epoch` 关联字段，现在在 remote-agent daemon 的 wire 上成为必填；投递的 turn-epoch 也开始持久化，重试因此留在其原本的 turn 内。本次发布改变了数据库 schema（新增一列可空字段），故需要 `db:rebuild`，且 wire 两端都必须已运行 v0.28.0。

### 变更

- **破坏性变更：** daemon wire 两个方向上的 `turn_epoch` 现在均为必填——`agent:status`（daemon→api；空闲时取值仍可为 null）与每一条 `agent:deliver` 投递条目（api→daemon）上皆是如此。可选字段的容错、api 侧字段缺失时走对账的分支、以及 daemon 自行签发的兜底 epoch 均已删除，`@synapse/device-protocol` 导出的 schema 形状随之改变。早于 v0.28.0 的对端会以 fail-closed 方式被切断——它们的帧被静默丢弃：旧 daemon 看起来仍然在线但状态永不更新，旧 api 的投递则一直卡在重试。全员 v0.28.0 的部署可以正常互通，因此上线本版本之前，请先把各对端升级到 v0.28.0。
- 设备运行时自报的版本字符串统一收敛到 `version.ts` 这一单一来源（取值不变——刻意与 npm 包版本解耦，因此发版升号绝不可能悄悄改变 wire 上可见的字符串）。
- 移动端离线聊天队列的常量改为取自 `@synapse/shared` 中权威的 `CHAT_QUEUE_*` 集合（字符串取值不变；无需数据迁移）。
- 出站传播器不再读取旧的 `http.url` span 属性（稳定的 `url.full` 始终存在；行为无变化）。

### 修复

- 投递重试不再每轮都签发一个新的 turn-epoch：epoch 在首次派发前按投递逐条持久化（新增可空列 `remote_agent_message_deliveries.turn_epoch`），重试因此会回到 api 侧同一个 carrier 分桶、daemon 侧同一个 turn。
- daemon 现在按 turn-epoch 对到达的投递分组，来自更早 turn 的迟到者不再能把新投递拖进旧 turn 的排空流程、过早地将其上报为失败。
- 更新日志翻译：修正三处改变原意的错误（西语文本把 "data-free" 误译出了一条不丢数据的保证；中文文本把已移除的 `expiresAt` 弱化成了弃用，并对 `operations` 允许列表的兼容性作了过度承诺）。

## [0.28.0] - 2026-07-24

分布式追踪 round-3 正确性修复（提交 `feaef0da`、`acaccade`、`ec41fdc3`）：为跨交错会话唤醒的 reverse-MCP 工具调用提供以 turn 为作用域的 trace 关联（F-r3-2）。它改变了 remote-agent daemon 的 wire 契约，需要一次**协同重新部署**——镜像的硬构建顺序与重建容器后的核对清单见 [`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §7 的上线运行手册，R3 的 daemon 先行上线顺序见 §7.4。本次无数据库 schema 变更，故无需 `db:rebuild`。

这也是各包 manifest 首次离开 `0.1.0` 的版本：`@synapse/device-protocol`、`@synapse/shared`、`@synapse/device-runtime`、`@synapse/device-sdk`、`@synapse/api` 与 `@synapse/remote-agent-daemon` 这组协同变更的包同步升到 `0.28.0`，其中四个运行时包发布到私有包注册表。平台运行时 bundle 与它们解耦，各自保持原有版本。

### 变更

- **破坏性变更：** remote-agent daemon 的 wire 在 `agent:deliver`（api→daemon）与 `agent:status`（daemon→api）两个方向上新增可选的 `turn_epoch`。两个帧都按 `z.strictObject` 校验，因此此改动之前构建的一端会整帧拒收，而非忽略这个新字段。向包注册表发布仍按依赖顺序进行——`@synapse/device-protocol` → `shared` → `device-runtime` → `remote-agent-daemon` 最后（`deploy.md` §5b）——但正在运行的部署要按 **daemon 先行**的顺序上线：由于受严格校验的新字段落在 `agent:deliver` 上，先于 api 升级 daemon 可保投递路径不受影响（旧 api 本就不带这个字段），新旧版本并存的窗口期内只剩 daemon 的 `agent:status` 帧会被尚未升级的 api 丢弃（turn 关联降级，但绝不丢投递）。反过来的顺序则会让每个带该字段的 `agent:deliver` 被整帧拒收，使投递陷入反复重试（仍是 at-least-once——不丢数据）。R3 的上线顺序见 [`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §7.4。
- 可发布的 @synapse 包现在是一组锁定到同一精确版本的协同重新部署集合；新增的 `guard:versions` 门控（在 `verify:boundary` 中运行）强制执行整组统一的版本号、组内互相精确锁定、平台 bundle 保持解耦，以及 package-lock 同步。

### 修复

- 交错的会话唤醒不再串 trace（F-r3-2）：某个 turn 上迟到的 reverse-MCP `tools/call` 会归属到该 turn 自己的投递来源，绝不会归到并发唤醒的后继 turn 名下。daemon 现在在一道 turn 门控之后持有权威的 per-turn epoch（每个会话同一时刻只跑一个 turn；抢跑的唤醒按调度顺序排队，逐个放行），api 侧 reverse-MCP 的 span link 以 daemon 确认的运行中 epoch 为键，turn 结束时则精确清空该 epoch 的待处理集合。另有一个陈旧机器连接的回收器，负责收尾操作系统从未关闭的套接字；且每个驱动每个 turn 至多发出一次终止信号，使这道门控绝无可能重复推进。

## [0.27.0] - 2026-07-23

分布式追踪 round-2 正确性修复（提交 `d1a8d96e`、`f3f5110a`、`8e4428e2`、`1e2018cd`），外加公网边缘加固。对运维者而言，重点是一次**协同重新部署**：本次发布改变了 wire、队列与遥测契约，精确步骤——镜像的硬构建顺序、`--force-recreate`、以及重建容器后的核对清单——见 [`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §7 的上线运行手册。本次无数据库 schema 变更，故无需 `db:rebuild`。

### 变更

- **破坏性变更：** 旧构建遗留的「已排队但未发送」聊天消息会在升级时被丢弃。离线聊天发件箱存储的队列状态在 **Web 与移动端两侧**作为一次性直接切换（不做兼容）升到了新版本（移动端快照 v2→v3；共享 `StoredChatQueueState` v4→v5，含 service worker）；客户端在首次加载时重建发件箱。已发送的消息与服务端数据均不受影响。
- Remote-agent daemon 应重新构建并重新发布（`deploy.md` §5b）：新增的 `agent:deliveries:completed` 帧（api→daemon）用于回收 daemon 的待投递集合，daemon 帧上的 trace 字段门控在 `wireTraceContextFields` 之下（经 schema 校验；畸形值按缺失处理）。此改动之前构建的 daemon 会静默忽略这个新帧，直到重新发布为止——受影响的投递保持待投递状态并重新通知，因此不丢数据。`AgentSession.setMcpServers` 已从驱动接口移除，并新增一条 CI guard 强制 api↔daemon 两侧帧对齐。（`fail-deliveries` 请求体重塑已随 v0.26.0 发布。）
- 按 `fastify.type=hook` 查询 span 的仪表盘或告警会失去这部分数据：`@fastify/otel` 升级到 0.20.1 并设 `instrumentHooks:false` 后，每个请求现在只产生一个 SERVER span，逐请求的生命周期 hook span 不复存在。第一方出站传播器现在无条件 fail-closed（不再向第三方发出 flags-`00` 的 `traceparent`，也不再发出继承而来的厂商 `tracestate`）；`OTEL_SERVICE_NAME`/`OTEL_RESOURCE_ATTRIBUTES` 现在能正确覆盖内置的 service name（此前的优先级是反的）。
- 收紧入站 `tracestate` 处理：`MAX_TRACESTATE_LENGTH` 从 1024 下调到 512（即 `@opentelemetry/core` 2.8.0 实际强制的值），键的文法则放宽到 W3C Level-2 超集。头部超过 512 字符、成员多于 32 个、键重复、值超长或成员畸形时，现在整体丢弃，而不再部分保留。
- 依赖打补丁从 `patch-package` 迁移到第一方的 `scripts/apply-patches.mjs` 应用器（postinstall 及 api/web/mobile-web 的 Dockerfile）；从 npm 安装的设备运行时不含 Go/Rust helper 二进制，现在会优雅降级并在启动时给出警告。

### 新增

- 公网边缘限流，作用于两个 public nginx 模板——`/api/` 与 `/ws` 上启用 `limit_req`，`/ws` 上另加 `limit_conn`（返回 `429` 而非 `503`；一次正常的页面加载绝不会触发），IPv6 在 TLS 边缘以 `/64` 前缀为键（njs）。另含不可伪造的 `x-synapse-trace-ingress` Ring-0 标记、供键控比例采样器使用的可选 `SYNAPSE_TRACE_SAMPLING_SALT`、显式的 Tempo `overrides.defaults` 上限，以及 `SYNAPSE_SERVER_TIMING_TRACE=on` 与比例采样器并存时的启动警告。阈值与可调参数见 [`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §6 与 §1。
- Web 与移动端的客户端 trace 关联：trace carrier 现在来自真实的 SDK span（消除了伪造的 span id），并在 WebSocket 认证/订阅帧前后加上短小的客户端 span。
- Go cua-helper 与 Rust fs-helper 逐 RPC 发出带 JSON-RPC semconv 属性的 SERVER span。
- 以 turn 为作用域的 trace-carrier 生命周期，api（`TurnCarrierCache`）与 daemon（turn-epoch）两侧皆然，修复了 reverse-MCP 的 span 归属；新增 `OTEL_TRACES_EXPORTER` 三态开关（未设置/`otlp`/`none`）与对 `OTEL_TRACES_SAMPLER` 不区分大小写的归一化；`@synapse/shared` 新增 tracestate 辅助函数（`sanitizeTracestateHeader`、`isValidTracestateHeader` 及文法常量）——均为纯新增。
- 本追溯性三语更新日志（English、简体中文、Español），以 50 个附注标签重建 v0.1.0–v0.26.2 的发布历史。
- CI：跨语言测试首次纳入门控（cua sidecar 的 `go test`、fs-helper 的 `cargo test`），trace 传播 guard 新增帧对齐与 turn 作用域规则。

### 修复

- Daemon fan-in 的 carrier 缓存：达到 20 条上限时，去重改为淘汰最旧的 carrier，而不是丢弃最新的——此前当前 turn 的 origin carrier 可能恰好是被丢弃的那一个。

## [0.26.2] - 2026-07-17

### 修复

- Remote-agent daemon：fan-in 的投递失败上报不再继承环境中已有的投递 trace；API 会签发一个全新的根 span 来关联所有来源，修复了混合来源的关联问题。

## [0.26.1] - 2026-07-17

### 新增

- 端到端 trace 传播贯通边缘与前端：在信任边界处，nginx 会剥离入站的厂商 trace-state 头（`tracestate`、`baggage`、`sentry-trace`），同时透传 W3C `traceparent`（API 在 extract 时会校验它，其 flags 仅供参考），Web 与移动端则将浏览器 span 桥接到该 `traceparent` 之上。

## [0.26.0] - 2026-07-17

### 新增

- Trace 消费方：daemon fan-in 关联、dispatch carrier、BullMQ producer span，以及贯通各 Python sidecar 的 OpenTelemetry。`resolution_traceparent` 会被持久化，因此重放的 resolution 帧能保留 resolver 的 trace。

### 变更

- **破坏性变更：** 重塑了 `POST /api/v1/internal/remote-agents/:remoteAgentId/fail-deliveries` 请求体的结构。

## [0.25.5] - 2026-07-17

### 新增

- 设备协议信封的 trace-carrier schema，以及逐消息的 WebSocket 追踪。trace 字段具备容错性——畸形或超大的值会按缺失处理，而不会拒收整条消息。

## [0.25.4] - 2026-07-16

### 变更

- 采样与导出改由 OpenTelemetry 掌管；Sentry 降级为消费方。`SENTRY_TRACES_SAMPLE_RATE` 改用作 Sentry 的转发速率。

## [0.25.3] - 2026-07-15

### 新增

- 共享的追踪基础设施：第一方的 trace-carrier 契约与传播器，以及一个 `@fastify/otel` 补丁。

## [0.25.2] - 2026-07-15

### 移除

- 保留但未启用的 `pty` 能力机制（`pty` builtin-kind 枚举成员、对应的策略，以及创建授权时的拒绝路径）。此前创建 pty 授权一律以 HTTP 400（`pty_not_supported`）失败；它从来都不是一项可路由的能力。

### 修复

- API Docker 镜像恢复可构建，修复了持续 14 天的故障——起因是一处无防护的 `cp -r` 复制了一个已被 icon 重构删除的 assets 路径。
- 两处 off-box sandbox 的符号链接逃逸：一是借 base-snapshot 符号链接向宿主机任意写入，二是利用 `envd` stat 跟随符号链接的行为在读取侧窃取宿主机文件。
- off-box 拆除路径中一处不涉及数据的收敛活锁。

## [0.25.1] - 2026-07-13

### 新增

- `cubesandbox:bare` off-box sandbox 提供方（E2B 兼容 wire 协议），带有词法路径限定——这是首个远程运行时适配器。

## [0.25.0] - 2026-07-12

### 新增

- `runtimes` 超类型：device 与 sandbox 成为挂在单一多态 `runtime_id` 上的子类型表。
- Sandbox 运行时泛化：一套 `${provider}:${mode}` 适配器注册表，含 on-box 的 `local:bare` 与 `docker:bare` bare 适配器，以及一个新的 `SANDBOX_MODE`（`resident`|`bare`|`auto`）运维设置——这正是 0.25.1 中 off-box 提供方所依托的底座。

### 变更

- **破坏性变更：** `device_*` 在整个 schema、设备协议 wire 格式（`DEVICE_*` → `RUNTIME_*` 枚举、`DeviceHelloParams` → `RuntimeHelloParams`、`pendingDeviceId` → `pendingRuntimeId`）以及 `OperationEnvelope` 字段中一律更名为 `runtime_*`。

### 移除

- `device_sync_sources` 表及其 `DEVICE_SYNC_SOURCE_KINDS`/`DEVICE_SYNC_MODES`/`DEVICE_SYNC_STATUSES` 导出（直接删除——无 `runtime_*` 替代）。其余 14 个 `device_*` 表及来自 `@synapse/device-protocol` 的 `Device*` 导出是更名而非移除（见「变更」）。

## [0.24.1] - 2026-07-03

### 新增

- 可通过环境变量选择的文档抽取（`DOCUMENT_EXTRACTION_PROVIDER`），配套一个 Apache Tika sidecar（PDF、DOCX、Markdown），在生产 profile 下默认启用，另有可选接入的云端提供方（TextIn xParse，以及带对账清扫器的异步 LlamaParse 路径）。至此提供方抽象工作全部完成：API 镜像不再打包任何推理引擎。

### 移除

- 打包的 `pdf-parse` 依赖。

## [0.24.0] - 2026-07-03

### 移除

- **破坏性变更：** 端到端移除 `audit_logs` 合规特性——`GET /api/v1/workspaces/:workspaceId/audit-logs` 路由、`AuditLog*` 导出，以及 `auditor` 平台角色。（这与仍然保留的 `/api/v1/logs` 和 `/api/v1/reports` 是两回事。）

## [0.23.1] - 2026-07-03

### 新增

- 可通过环境变量选择的 embedding（`EMBEDDING_PROVIDER`），配套一个自托管的 bge-m3 sidecar，以及一个面向云端/自托管 embedding 厂商的通用 OpenAI 兼容适配器。

### 变更

- Memory 向量从 `VECTOR(384)` 改为 `VECTOR(1024)`（e5-small → bge-m3）；既有 embedding 必须重新生成。

### 移除

- 打包的 `@huggingface/transformers` 依赖。

## [0.23.0] - 2026-07-02

### 新增

- 自托管的 `sherpa-stream` 实时 ASR sidecar，以及一个提供方 session-factory。

### 变更

- **破坏性变更：** `ASR_PROVIDER` 默认值改为 `none`。既有实时 ASR 部署必须设置 `ASR_PROVIDER=volcengine`，否则 `/ws/asr` 听写网关将不再返回结果。

## [0.22.2] - 2026-07-02

### 新增

- 可通过环境变量选择的批量转录，配套 sherpa-onnx 与 faster-whisper sidecar（即 `asr` Compose profile），将批量音频转录恢复为进程外能力。

## [0.22.1] - 2026-07-02

### 新增

- 可通过环境变量选择的 OCR（`OCR_PROVIDER`），配套 tesseract 与 PP-OCRv6 sidecar，在生产 profile 下默认使用 tesseract。

### 移除

- 打包的 `tesseract.js` 依赖。

## [0.22.0] - 2026-07-01

### 新增

- 无后端的 `web-next-design` UI sandbox（类型化的模拟 `ApiClient`），用于设计迭代。

### 变更

- **破坏性变更：** IM 与 MCP 插件的品牌图标改用 React 组件实现；`iconUrl`、`pluginIconUrl` 和 `iconAssetPath` 响应字段已移除。

### 移除

- `PLATFORM_ASSET_FILE_ORIGIN_SYSTEMS` 导出，以及 MCP 图标 seed 流水线。

## [0.21.2] - 2026-07-01

### 新增

- 编译期契约一致性断言，覆盖所有共享的 type/schema 配对；另新增若干 `@synapse/shared` 导出（持久化的 content-block schema、transport-account schema 等）。

### 修复

- 手写类型与其对应 Zod schema 之间的漂移。

## [0.21.1] - 2026-06-22

### 新增

- Firecrawl（托管的远程 MCP），以及 Notion、Xiaohongshu（小红书）、Bilibili 的 MCP sidecar——全部由环境变量门控；这三个 sidecar 共享一个新的 `_mcp_base` Python 框架，既有的 Mijia 插件也一并迁移到其上。

## [0.21.0] - 2026-06-21

### 新增

- Telegram（Bot API）、WhatsApp（Cloud API）与 WhatsApp-unofficial（Baileys QR）连接器，以及 ffmpeg 语音转码器。
- 边缘压缩：自定义构建的 nginx，支持 Brotli、Zstandard 与 RFC 9842（`.dcb`/`.dcz`）增量字典压缩。
- 浏览器遥测接入：`POST /api/v1/reports`（NEL / Reporting API），并在每个响应上通过 `Server-Timing`/`traceresponse` 头暴露该请求的 trace id。

### 变更

- **破坏性变更：** 授权 DTO 字段 `memberId` → `workspaceMemberId`、`grantedByWorkspaceMemberId` → `createdByWorkspaceMemberId`；`SubjectRef.memberId` → `workspaceMemberId`。

### 移除

- `MCP_TOOL_NAMESPACE_SEPARATOR` 与 `PublicToolOrigin` 导出。

## [0.20.1] - 2026-06-21

### 新增

- 将 HKUDS/CLI-Anything 内化为 `cli-catalog` device-runtime builtin（66 个 CLI），并配以服务端签发门控。

## [0.20.0] - 2026-06-19

### 新增

- 多后端内容存储：逐 blob 选择后端、本地 CAS 缓存、S3 远程后端（`@aws-sdk/client-s3`，支持预签名 PUT/GET），以及 sandbox 的 CAS 预载。

### 变更

- **破坏性变更：** `resource_access_bindings` 并入 `workspace_resource_grants`；wire 格式 `{app}` → `{resource}`、`appId` → `resourceId`；逐类型的访问子资源统一收敛为 `GET|PUT .../workspace-resources/:resourceId/grants`；新增 `automation_admin` workspace 访问键。

### 移除

- `resource_access_bindings` 模型及其导出（`ResourceAccessBindingResourceType`、`ACCESS_BINDABLE_*`）。

## [0.19.0] - 2026-06-18

### 变更

- **破坏性变更：** create-invite 请求 DTO 移除绝对时间 `expiresAt`，改用相对时长 `expiresInHours`；客户端若仍发送 `expiresAt`，该字段会被静默忽略。
- 规范的 `IsoInstantString` 原语及其转换辅助函数迁移至 `@synapse/device-protocol/instant`，并经 `@synapse/shared` 再导出。
- `workspace_app_grants.created_at` 收紧为 `NOT NULL`（去掉了 1970-epoch 回退）；时长列（`retention_ttl_ms`、`poll_interval_ms`、`ttl_ms`）扩展为 `BIGINT`，并加上 `>= 0` 的 CHECK 约束。

## [0.18.2] - 2026-06-18

### 新增

- 统一日志与分布式追踪：单一 pino logger 配领域分类法，OpenTelemetry 搭配 Tempo、Loki 与 Alloy，自托管、DSN 门控的 Sentry 作为错误/性能消费方，BullMQ trace 传播，以及 `/api/v1/logs` 客户端日志接入端点（以用户 session 或短时效的 HMAC 设备令牌认证）。
- IM 入站与出站媒体在内容寻址流水线上打通：DingTalk 媒体（入站 + 出站）、QQ 入站媒体写入 CAS、WeChat 入站媒体（并修复一处 aes_key 编码问题），以及出站上传前的空 blob 防护。

## [0.18.1] - 2026-06-17

### 变更

- 传输层的 `CanonicalFileRef` 收敛为单一的内容寻址（sha256）形态；Feishu、QQ、WeChat 的出站发送改为从 CAS 读取字节，Feishu 的入站媒体则持久化到 CAS。

### 修复

- 连接器修复：Feishu webhook 校验、`@all` 提及归一化以及入站视频；QQ 官方 OpenAPI v2；DingTalk 的提及/富文本/音频处理；WeChat（ilink 个人微信）连接器重新对齐上游协议（session guard、扫码登录、媒体 CDN）。

## [0.18.0] - 2026-06-17

### 变更

- **破坏性变更：** 带响应体的应用 REST 响应改为统一包裹进 `{ data }` 信封（约 173 条路由）；无响应体的写操作仍为 `204`，而 wire/机器接口端点（设备握手、`/api/v1/internal/*`、`/auth/device/*`、`/im/webhooks/*`、`/automation-webhooks/*`、`/install.{sh,ps1}`）有意保持裸载荷。Postgres 保持 snake_case，TypeScript 侧则通过 Kysely `CamelCasePlugin` 全面使用 camelCase。错误契约（`{ error, code }`）有意保持不变。
- repo-exit 的 JSON 解码改为对畸形的存储载荷 fail-closed（此前会静默强制转为 `{}`），覆盖大多数模块。

## [0.17.0] - 2026-06-10

### 新增

- 统一的 MCP 风格 Task 模型（`tool_call_task_*` 表），生命周期正交拆分为 `lifecycle_status` × `outcome`。
- 规范的 `IsoInstantString` datetime 原语、`datetime/instant.ts` 适配器，以及 `guard-datetime-boundaries` CI 检查。

### 变更

- **破坏性变更：** `POST .../interactions/:id/respond` → `POST .../tasks/:taskId/respond`；WebSocket feed 事件 `interaction_requested` → `task_requested`，其载荷 `{interaction}` → `{task}`。合并了 workspace-app 根元数据。

### 移除

- `interaction_*` 表、`InteractionRequestSummary` 及相关导出，以及旧版 workspace-app 写路由。

## [0.16.0] - 2026-06-07

### 新增

- 服务端计算的工具调用展示层：display block、捕获的 MCP `_meta`，以及为内置工具自动附加的描述符。
- `@synapse/shared` 新增导出（`resolvePresentation`、`PresentationString`），并在 `ServerToolCall`、`ToolPlugin` 和 turn-preview/activity DTO 上新增展示字段。

## [0.15.0] - 2026-06-07

### 变更

- **破坏性变更：** 规范的 `ToolResultOrigin` 联合类型（及 `TOOL_RESULT_ORIGIN_KINDS`）统一并入路由词表——`mcp_remote|mcp_device|callable_plugin|builtin` → `system|plugin|device|provider_native`——并为各 kind 引入新的字段形态，`origin` 也改为 `CanonicalToolResult`/`NormalizedMcpToolResult` 上的必填字段。
- **破坏性变更：** `ActorRuntimeToolKind` 枚举取值重新映射（`callable|mcp_plugin|mcp_device|provider_builtin` → `system|plugin|device`）；WebSocket 与 turn-preview DTO 的取值随之改变。

### 移除

- `ExecutableModelToolKind` 与 `execKindForSource` 导出。
- 从 `device` 派生的 catalog/marketplace 枚举成员（`device_derived`、`device_derivation`、`device_projection`，以及 catalog source `device`）、`device` 插件传输、`actor_in_conversation`/`remote_agent_in_conversation` 访问目标标签，以及 `conversationActorContextId`。

## [0.14.1] - 2026-06-07

### 新增

- nginx 新增 HTTP/3（QUIC）支持。

## [0.14.0] - 2026-06-06

### 新增

- 工具溯源与路由（`ToolRef` + `NameRegistry`）：确定性的 `toolId`、wire-name ↔ toolId 注册表，以及不可变的 `tool_calls.source_snapshot`。

### 变更

- **破坏性变更：** 工具溯源与路由——路由不再解析工具名称（projection 会生成确定性的 `ToolRef` + 逐 turn 的 `NameRegistry`）；`ToolDefinition.source`/`sourceType` 已从 `@synapse/shared` 移除（source 现在挂在内部的 `ProjectedToolDefinition` 上）。

### 移除

- 旧版 `tool_calls.plugin_id`/`device_id` 列，以及 `tool_execution_attempts.plugin_id`/`device_id`/`instance_key` 列（溯源改为从父级 `tool_calls.source_snapshot` 派生）。

## [0.13.0] - 2026-06-06

### 变更

- **破坏性变更：** 重构了内置工具的执行 kind 模型——移除 `ToolPlugin.kind`（`action`|`callable`）字段并将 `ToolPlugin.execute` 设为必填；`ActorRuntimeToolKind` 联合类型去掉了 `builtin` 与 `action` 成员（均在 `@synapse/shared`）。

## [0.12.0] - 2026-06-06

### 新增

- Vercel AI SDK v6 提供方层，以及 `deepseek` 厂商。

### 变更

- **破坏性变更：** 模型相关的数据模型合并为 `model_bindings` + `model_binding_versions`（替代 `model_profiles`、`model_profile_revisions` 与 `model_group_profiles`）；`provider_steps` 改以 `model_binding_id`/`model_binding_version_id` 为键。
- **破坏性变更：** 调整了 `ResolvedModelConfig` 的结构（`bindingId`、`providerKind`、`maxOutputTokens`）；共享导出更名：`MODEL_PROVIDER_CATALOG` → `MODEL_VENDOR_CATALOG`（`ModelProviderDefinition` → `ModelVendorDefinition`），并新增 `ProviderKind` 导出。

### 移除

- 四个手写的 LLM 适配器、`ModelProviderAdapter*`/`EngineBranch*` 导出，以及 provider-native 的分支状态恢复。

## [0.11.3] - 2026-06-06

### 修复

- 多客户端聊天广播可能漏掉事件：并发追加时逐成员的 `member_seq` 不保证连续无间隙（客户端游标按 `member_seq > cursor` 分页）。现在 `member_seq` 在逐成员的 advisory 事务锁（`pg_advisory_xact_lock`）下按 `MAX+1` 分配，保证序列连续且与提交顺序一致。

## [0.11.2] - 2026-06-06

### 新增

- 一键式、跨平台的 Node 安装器，通过 `GET /api/v1/install.sh` 与 `install.ps1` 提供（sha256 校验，自动探测中国/国际镜像源）。

## [0.11.1] - 2026-06-05

### 新增

- 软删除墓碑机制，配套 `_live` 读视图、离线清除 CLI（`db:purge:*`），以及由表分类清单支撑的 FK-policy CI 门控。
- 弹窗优先的 OAuth 登录，支持跨平台（web/mobile）错误路由，补全了 Feishu 社交登录流程。

### 变更

- 删除改为墓碑标记：`ON DELETE CASCADE` 在整个仓库范围内改为 `RESTRICT`。依赖级联删除的运维 SQL 现在会触发外键约束错误，且 schema 初始化需要 `CREATEROLE` 权限。

### 修复

- 发往 `gpt-5*` 与 o 系列（o1/o3/o4）推理模型的 OpenAI 请求改为发送 `max_completion_tokens`，不再使用会被拒绝的旧参数 `max_tokens`。

## [0.11.0] - 2026-06-04

### 新增

- Feishu（Lark）社交登录，并全面翻新了登录/注册 UX（单列布局、密码可见性切换、邮箱自动建议、大写锁定警告，以及具体的登录错误提示）。
- 服务端 actor sandbox 现在可通过新的部署脚本（`deploy-sandbox-docker.sh` / `deploy-sandbox-local.sh`）、`docker-compose.sandbox-local.yml`，以及基于官方 frp release 构建的 frps 隧道边缘镜像，在 Docker 与本地两种模式下部署。

### 变更

- **破坏性变更：** 模型配置从环境变量迁移到声明式的 `config/model-groups.yaml`。

### 移除

- `AI_PROVIDER`、`AI_ENGINE_KIND`、`AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL` 与 `AI_MAX_TOKENS`。聊天需要显式的 model-group 配置；全新安装启动时不带任何模型配置。

## [0.10.0] - 2026-06-04

### 新增

- 引入 Better Auth 1.6.13 处理身份认证（`account`/`session`/`verification` 表），以及 RFC 8628 设备授权。

### 变更

- **破坏性变更：** 认证端点整体调整（`/register` → `/sign-up/email`、`/login` → `/sign-in/email` 等）；需要新的 `BETTER_AUTH_SECRET`（可回退到 `AUTH_SECRET` / `APP_SECRET`）。

### 移除

- `users.password_hash`、`auth_sessions`、六条 `/qr-login/*` 路由，以及按配置邮箱自动授予超级管理员的机制。

### 安全

- 升级时所有密码与 session 均失效（无迁移路径）。移除了硬编码的 session-cookie 名称。

## [0.9.1] - 2026-06-04

### 新增

- Gitleaks 密钥扫描接入 pre-commit 钩子与 CI（`secret-scan` workflow），配套一份 `.gitleaks.toml` 配置和一份收录已知允许匹配项的基线。

### 变更

- 授权加固：穷尽式权限 switch，以及对未知权限的 fail-closed 处理。

### 修复

- workspace 权限求值器在 admin 检查之前就拒绝了 `manage_relays` 键，导致 owner、admin 与 device-admin 键持有者的设备管理被静默收窄为只能管理自己的设备。

## [0.9.0] - 2026-06-03

### 新增

- 官方远程 MCP 端点（AMiner、AMap、Figma），基于 HTTP 与 SSE，使用官方 SDK 的传输实现。

### 变更

- **破坏性变更：** Mijia（小米智能家居）插件从常驻的进程内 builtin 改为由环境变量门控的 sidecar（`MIJIA_MCP_URL`），需启用 `mijia` Compose profile——在生产 profile 下现在默认关闭。

### 移除

- 手写的 `McpHttpClient`。

## [0.8.1] - 2026-06-03

### 新增

- 为 actor sandbox 新增 E2B-SDK 风格的 `SandboxBackend` 生命周期抽象（`create`/`connect`/`kill`/`getHost`），提供本地后端与可选启用的 Docker-outside-of-Docker 后端、一个快速路径端点，以及 fs-helper 的 `fs.hello` 新鲜度握手。

## [0.8.0] - 2026-06-02

### 新增

- 一个以 sha256 为键的内容寻址文件服务（`content_blobs`、`file_assets`、`file_spaces`、`file_snapshots`、`file_mounts`）。
- 一个服务端 actor sandbox 模块：逐 session 的生命周期、一个负责拉起 device-runtime 子进程的本地宿主提供方、基于新文件服务的工作集物化（`file_snapshots`、`file_mounts` 表），以及 sandbox 授权、GC 与冲突通知处理。

### 变更

- **破坏性变更：** 加密信封从 `enc:` 迁移到 `enc:v2:`（scrypt KDF），且不提供重新加密路径；随着数据层统一到 Kysely，绕过它直接执行裸 pg 查询的通道也一并移除。

### 移除

- 进程内的 sherpa-onnx-node 批量 ASR 引擎。

### 安全

- 对环境配置的 fail-fast Zod 校验、SSRF 加固（含带方括号的 IPv6），以及一个新的 fail-closed `redactSecrets` 密钥脱敏器。新增一个必填的 `SYNAPSE_REGISTRY_DOMAIN`。

## [0.7.1] - 2026-06-01

### 新增

- 一个自托管的 Verdaccio 私有 npm 注册表，用于分发 device runtime 与 remote-agent daemon；并为十个包添加了 `publishConfig`。

## [0.7.0] - 2026-05-31

### 变更

- **破坏性变更：** 将所有 workspace 迁移到 Zod 4（锁定 `4.3.6`）；会话是否为 IM 会话改由其传输绑定派生，chat 创建与添加参与者的 DTO 也随之调整。

### 移除

- 旧版 A2A 设计（`A2AApp`、`A2AAgentCard` 及相关导出）、`CONVERSATION_BOUNDARY`/`CONVERSATION_BOUNDARIES`，以及 `systemRef`。

## [0.6.1] - 2026-05-29

### 新增

- 一个逐 agent 的 computer-use（CUA）session 焦点子系统。

## [0.6.0] - 2026-05-29

### 新增

- 一项通过 chrome-devtools-mcp 提供的浏览器能力，带 operation-aware 的 projection 和手动授权。

### 变更

- 设备协议的 `RuntimeBrowserPolicySchema` 新增 operation 级 `operations` 允许列表（匹配器在缺项时 fail-closed）。
- **破坏性变更：** 设备协议的 `DeviceCapabilitySummarySchema` 新增一个必填的 `exposure_stable_key` 字段（另新增可选的 `metadata`）。

## [0.5.0] - 2026-05-29

### 新增

- 终端能力 v2（`exec_file`、`powershell`），随附一套内置工具链，以及六个通过 Git LFS 分发的 `device-runtime-bundles-*` 平台包。

### 变更

- **破坏性变更：** 重新设计了设备协议的 `CommandlinePolicy` wire schema。构建本项目现在需要 Git LFS。

## [0.4.0] - 2026-05-29

### 新增

- `@synapse/device-runtime` npm CLI（`synapse-device`）、一项由新的 Rust fs-helper sidecar 支撑的设备文件系统能力（13 个工具），以及 QQ（官方 OpenAPI v2）与 DingTalk（Stream）连接器。

### 变更

- **破坏性变更：** 设备控制平面迁移到 `GET /api/v1/devices/control-plane` WebSocket 端点（JSON-RPC 2.0 帧格式）；设备身份改用两对密钥；配对迁移到 `POST /api/v1/devices/pairing-sessions/consume`。构建本项目现在需要 Rust 工具链（用于 fs-helper sidecar）。

### 移除

- 整个 Go `relay/` 子系统（−66,599 行）：relay CLI、桌面 GUI、agent 以及 FUSE 挂载；`/ws/relay`；十三个 `relay_*` 表；relay 自动更新清单；以及 TLS 公钥固定。

### 安全

- 新增必填的 `SYNAPSE_DEVICE_TRUSTED_SERVER_KEYS`（未设置时将拒绝所有工具调用），以及工具调度必需的 frp 隧道。

## [0.3.0] - 2026-05-27

### 新增

- 为主体模型新增 scope 维度（`ScopedSubjectTarget`、`scope_subject_id`），以及 `memory_access_grants` REST 端点。

### 变更

- **破坏性变更：** `AccessTarget` 与 `CapabilityAccessTarget` 改为基于 `ScopedSubjectTarget` 建模。
- **破坏性变更：** memory DTO 改为基于主体模型建模：`MemoryEntry` 以 `owner`/`scope`（`SubjectRef`）+ `namespaceKey` 替代 `spaceType`/`ownerScope`/owner-id 字段；`memory_saved`/`memory_updated` feed 事件以 `memoryOwner`/`memoryNamespaceKey` 替换 `memorySpaceType`；`RelayAuthorizationGrantSummary.scope`（枚举）变为 `subject` + 可选的 `scope` `SubjectRef`。

### 移除

- 旧版访问目标类型、`MEMORY_SCOPES`/`MEMORY_SPACE_TYPES`，以及 `relay_authorization_grants.scope`。
- `conversation_actor_context` 主体变体——`SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT`、`ACCESS_RESOURCE_TYPE.CONVERSATION_ACTOR_CONTEXT`，以及 `conversationActorContextRef` / `isConversationActorContextSubject` 导出（会话内 actor 的场景改以 `actor` + `scope=conversation` 表示）。

## [0.2.0] - 2026-05-25

### 新增

- 一个 `access_subjects` 注册表，将此前多态的主体模型统一到单一的 `subject_id` 之上。
- 一个 IM `TransportConnector` 抽象，带连接器注册表，以及可用的 Feishu（Lark）、Weixin（个人微信）与 WeCom 连接器（Feishu/Weixin 此前只是 9 行的能力桩），一个逐会话的 reverse-MCP 端点，一个面向 remote-agent daemon 的 `AgentDriver` 抽象，以及 Docker Compose 生产部署（`tls`/`http`/`certbot` profile）。

### 变更

- **破坏性变更：** 会话与交互路由迁移到 `/chat/*` 之下（旧 URL 返回 404）；WebSocket 事件名改为点分形式（`auth_error` → `auth.error`、`server_shutdown` → `server.shutdown`）；Docker Compose 新增十一个必填环境变量（`APP_BASE_URL`、`SYNAPSE_PUBLIC_DOMAIN` 等），缺失时直接启动失败，必填集由此扩大到十五个。

### 移除

- 宿主机 systemd 部署（unit 与启动脚本）；`@synapse/shared` 的 `Message`、`MessageType`、`ConversationSummary`、`SESSION_CHANNELS` 与 `ChannelType` 导出；裸 `/files/*` 挂载；以及 `sessions.channel_type`。

## [0.1.0] - 2026-05-20

首个发布版本。Synapse 是一个面向数字同事的自托管、以会话为中心的运行时：AI actor 与桥接的编码 agent 加入你的 workspace，在会话里与你协作，而且从你已在使用的 IM 应用即可触达。会话本身即协作边界——参与者、transcript 可见性、actor 执行、唤醒与记忆交接均由它治理。

### 新增

- **会话模型** — 所有协作都发生在一个与渠道无关的会话图中：`conversations`（kind 为 group/private/virtual，含 internal/external 边界）、多态的 `conversation_participants`（workspace_member、actor、remote_agent、external、system），带逐参与者的已读水位线，以及一个类型化的 `conversation_items` 日志（message/event/summary/control；user/assistant/system/tool 角色），承载 shared/private scope、visible/internal surface、事件 fan-out 策略、逐会话单调递增的序列、reply/cause 串联、多段式消息体（text/file_ref/json），以及 to/cc/visible 定向与提及。
- **IM 连接器** — 在你已在使用的 IM 应用里与同事聊天：一个 Feishu（飞书）机器人（webhook + 长连接，direct + group），以及通过扫码配对接入的 Weixin（个人微信）（长连接，仅 direct），二者由一个通用的五表传输抽象（accounts、endpoints、逐会话绑定、addresses、逐 item 的投递链接）统一承接。
- **平台原生 actor** — workspace 范围、云端运行的 AI 同事，带类型化角色（secretary/manager/specialist/reviewer/archivist/receptionist/assistant）、一套 actor 层级、`can_represent_user`，以及完整的版本化历史（`actor_versions`），其溯源信息会将每次编辑归因到某个 member、actor、system 或 sync 来源。
- **桥接的 remote agent** — 带上你自己的编码 agent：运行在用户自己机器上的外部 agentic 运行时（Claude Code、Codex）经由 `remote-agent-daemon` 以参与者身份加入 workspace——它是一个本地 Node 驱动，经 WebSocket 向外建连，探测已安装的 CLI，逐 turn 拉起它们，并通过注入的 stdio MCP server 桥接聊天——配套机器配对/信任、plan 审批协作，以及群内交互授权。
- **经由 Go relay 的设备工具** — 让 agent 受控地访问一台物理机器：一个独立的设备端 agent（`synapse-relay` CLI、Wails 桌面 GUI、FUSE 挂载）负责配对机器，并通过带版本的 WebSocket 调度协议将其作为已授权的 MCP 工具暴露给云端，内置 computer-use（CUA）、范围受限的文件系统、随附的 Chrome DevTools 以及命令行服务器。
- **workspace 治理与权限** — 一套两级 RBAC：平台级的 `platform_access_bindings`（super_admin/workspace_admin/model_admin/support/auditor），支持通过环境变量配置来引导超级管理员；以及 workspace 级的 `workspace_members`（admin/member/guest），带八个细粒度的管理能力键、基于令牌的邀请，以及一个多态的 `resource_access_bindings` ACL——将资源授予 workspace/conversation/actor 主体。
- **认证** — 一套手写的身份栈：bcrypt 密码登录，不透明的 sha256 bearer session（cookie 或 Authorization 头），带客户端/传输元数据与生命周期，以及一个完整的双令牌扫码跨设备登录状态机。
- **可分享的同事与联系人** — 一个逐 workspace、WeChat 风格的关系图，覆盖 member、actor 与 remote agent：可分享的身份 profile（带可搜索 ID 与二维码令牌）、带自动/手动审批的好友请求，以及已接受的联系人列表条目。
- **catalog 与 marketplace** — 安装并分享打包好的能力：一条 publisher → item → version 的主干链路，覆盖三种 package kind（actor_template、skill_package、plugin_package），带分类、版本文件与逐 kind 的 spec；从 GitHub/ClawHub 镜像源摄取 skill 并解析为快照；以及 workspace 租户的已安装 skill 与 plugin-installation 运行时表，配 OAuth 风格的 plugin 认证 session 与逐 owner 的连接。
- **模型组与 LLM 提供方** — 四个手写的提供方适配器（Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、BigModel/Zhipu GLM），统一挂在一个静态的提供方目录之下，另加由数据库支撑的路由子系统：版本化的 model profile、带 weighted-random/round-robin/priority-failover 策略与 attempt 策略的 `model_groups`、范围受限的授权，以及 actor→组的指派；运行时的提供方/模型通过环境变量选择。
- **MCP 工具与插件** — 一个四传输的 MCP 插件宿主（builtin、stdio、http、relay），架于一套七 kind 的工具分类法之上，随附七个 builtin 插件（feishu、aminer、amap、github、gitlab、mijia，以及 Zhipu z-ai 工具包——涵盖搜索、阅读、OCR/视觉、音频/语音、媒体生成与内容审核），带运行时权限审批和挂载/复用范围限定。
- **Memory** — 同事拥有记忆：进程内的混合语义记忆，划分为五个 scope（workspace_shared、conversation_shared、actor_private、participant_private、user_private），横跨七个 item 分类，结合词法（FTS + trigram）与向量召回——经由一个内置的 transformers.js `multilingual-e5-small` 模型（VECTOR(384)、HNSW cosine）在本地做 embedding、无需外部 sidecar，并留存每次召回的运行记录。
- **自托管部署** — 可运行在单台 Ubuntu 宿主机上：nginx 公网入口、面向 API 与桌面 web（`packages/web-next`）的 systemd、容器化的 PostgreSQL（pgvector/pg16）与 Redis 7、一个以 tsx 运行的 API 镜像，以及一个用于整套容器化栈的 `production` Compose profile；并随附一个 Expo 移动端 app，以及 English、简体中文、Español 三种语言的 README/CHANGELOG。

[Unreleased]: https://github.com/zai-org/Synapse/compare/v0.29.1...HEAD
[0.29.1]: https://github.com/zai-org/Synapse/compare/v0.29.0...v0.29.1
[0.29.0]: https://github.com/zai-org/Synapse/compare/v0.28.0...v0.29.0
[0.28.0]: https://github.com/zai-org/Synapse/compare/v0.27.0...v0.28.0
[0.27.0]: https://github.com/zai-org/Synapse/compare/v0.26.2...v0.27.0
[0.26.2]: https://github.com/zai-org/Synapse/compare/v0.26.1...v0.26.2
[0.26.1]: https://github.com/zai-org/Synapse/compare/v0.26.0...v0.26.1
[0.26.0]: https://github.com/zai-org/Synapse/compare/v0.25.5...v0.26.0
[0.25.5]: https://github.com/zai-org/Synapse/compare/v0.25.4...v0.25.5
[0.25.4]: https://github.com/zai-org/Synapse/compare/v0.25.3...v0.25.4
[0.25.3]: https://github.com/zai-org/Synapse/compare/v0.25.2...v0.25.3
[0.25.2]: https://github.com/zai-org/Synapse/compare/v0.25.1...v0.25.2
[0.25.1]: https://github.com/zai-org/Synapse/compare/v0.25.0...v0.25.1
[0.25.0]: https://github.com/zai-org/Synapse/compare/v0.24.1...v0.25.0
[0.24.1]: https://github.com/zai-org/Synapse/compare/v0.24.0...v0.24.1
[0.24.0]: https://github.com/zai-org/Synapse/compare/v0.23.1...v0.24.0
[0.23.1]: https://github.com/zai-org/Synapse/compare/v0.23.0...v0.23.1
[0.23.0]: https://github.com/zai-org/Synapse/compare/v0.22.2...v0.23.0
[0.22.2]: https://github.com/zai-org/Synapse/compare/v0.22.1...v0.22.2
[0.22.1]: https://github.com/zai-org/Synapse/compare/v0.22.0...v0.22.1
[0.22.0]: https://github.com/zai-org/Synapse/compare/v0.21.2...v0.22.0
[0.21.2]: https://github.com/zai-org/Synapse/compare/v0.21.1...v0.21.2
[0.21.1]: https://github.com/zai-org/Synapse/compare/v0.21.0...v0.21.1
[0.21.0]: https://github.com/zai-org/Synapse/compare/v0.20.1...v0.21.0
[0.20.1]: https://github.com/zai-org/Synapse/compare/v0.20.0...v0.20.1
[0.20.0]: https://github.com/zai-org/Synapse/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/zai-org/Synapse/compare/v0.18.2...v0.19.0
[0.18.2]: https://github.com/zai-org/Synapse/compare/v0.18.1...v0.18.2
[0.18.1]: https://github.com/zai-org/Synapse/compare/v0.18.0...v0.18.1
[0.18.0]: https://github.com/zai-org/Synapse/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/zai-org/Synapse/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/zai-org/Synapse/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/zai-org/Synapse/compare/v0.14.1...v0.15.0
[0.14.1]: https://github.com/zai-org/Synapse/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/zai-org/Synapse/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/zai-org/Synapse/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/zai-org/Synapse/compare/v0.11.3...v0.12.0
[0.11.3]: https://github.com/zai-org/Synapse/compare/v0.11.2...v0.11.3
[0.11.2]: https://github.com/zai-org/Synapse/compare/v0.11.1...v0.11.2
[0.11.1]: https://github.com/zai-org/Synapse/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/zai-org/Synapse/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/zai-org/Synapse/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/zai-org/Synapse/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/zai-org/Synapse/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/zai-org/Synapse/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/zai-org/Synapse/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/zai-org/Synapse/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/zai-org/Synapse/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/zai-org/Synapse/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/zai-org/Synapse/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/zai-org/Synapse/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/zai-org/Synapse/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/zai-org/Synapse/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/zai-org/Synapse/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/zai-org/Synapse/releases/tag/v0.1.0
