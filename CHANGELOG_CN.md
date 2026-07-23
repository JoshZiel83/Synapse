# 更新日志

[English](./CHANGELOG.md) · **简体中文** · [Español](./CHANGELOG_ES.md)

本文件记录本项目所有值得关注的变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，本项目力求遵循
[语义化版本](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。

> [!WARNING]
> Synapse 仍处于早期设计与实现阶段（pre-1.0，当前 `0.1.0`）。按 SemVer 的 0.x 规则，任何
> 版本都可能包含破坏性变更，且目前不承诺兼容旧数据。破坏性变更通过重建数据库
> （`npm run db:rebuild`）并重新部署来对齐，而非迁移——见 [`deploy.md`](./deploy.md)。

## [Unreleased]

分布式追踪 round-2 正确性修复（提交 `defdece3`、`f6c456b5`、`cd615060`、`79ddc845`）。
它们改变了 wire、队列与遥测契约，需要一次**协同重新部署**——精确步骤（硬构建顺序、
`--force-recreate`、以及落地后核对清单）见
[`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md) §7 的
Rollout 运行手册。本次无数据库 schema 变更，故无需 `db:rebuild`。

### Breaking（破坏性）

- **聊天发件箱队列状态版本升级（移动端）。** 离线聊天发件箱存储的队列状态作为干净断裂
  升到新版本。旧版本中处于「已排队但未发送」的消息在升级时被丢弃；移动端在首次加载时重建
  发件箱。已发送的消息与任何服务端数据都不受影响。
- **remote-agent 守护进程 wire 协议。** `fail-deliveries` 帧体被重塑，并新增
  `agent:deliveries:completed` 帧（二者现在携带带签名的 `wireTraceContextFields`，而非裸
  字符串）。此改动之前构建的 daemon 对这些帧会收到 `400`，直到重新构建并发布
  （`deploy.md` §5b）；受影响的投递保持 pending 并重新通知，因此不丢数据。
  `AgentSession.setMcpServers` 已从驱动接口移除。
- **`@fastify/otel` 逐 hook span 移除；出站传播器 fail-closed；OTel service-name 优先级修正
  （api）。** `@fastify/otel` 升级到 0.20.1 并设 `instrumentHooks:false`，于是每个请求现在
  只产生一个 SERVER span，每请求 8 个生命周期 hook span 消失——任何按 `fastify.type=hook`
  查询的仪表盘或告警会失去这部分数据。第一方出站传播器现在无条件 fail-closed：不再向第三方
  发出未采样的 flags-`00` `traceparent`（也不再发出继承而来的厂商 `tracestate`）。
  `OTEL_SERVICE_NAME` 与 `OTEL_RESOURCE_ATTRIBUTES` 现在能正确覆盖内置的 service name（此前
  优先级是反的）——依赖旧行为的部署会看到其上报的 service name 改变。（Sentry 默认仅
  errors 会降低 span 量，但这本身不是破坏性变更。）
- **入站 `tracestate` 上限与文法收紧。** `MAX_TRACESTATE_LENGTH` 从 1024 下调到 512
  （`@opentelemetry/core` 2.8.0 实际强制的值），并把 `tracestate` 键文法放宽到 W3C
  trace-context Level-2 超集。入站 `tracestate` 超过 512 字符或超过 32 个成员时，现在整体
  丢弃，而不再静默地部分抢救。

### Added（新增）

- **公网边缘限流与 Ring-0 ingress marker。** 在两个 public nginx 模板上做宽松限流——`/api/`
  上 `limit_req`、`/ws` 上 `limit_conn`（返回 `429` 而非 `503`；一次正常约 30 请求的页面
  加载绝不触发），IPv6 在 TLS 边缘按 `/64`（njs）、在 http profile 按整地址 key。另含不可
  伪造的 `x-synapse-trace-ingress` Ring-0 marker、给 keyed ratio 采样器用的可选
  `SYNAPSE_TRACE_SAMPLING_SALT`，以及显式的 Tempo `overrides.defaults` 兜底上限。阈值与旋钮
  见 [`docs/logging-refactor/04-operations.md`](./docs/logging-refactor/04-operations.md)
  §6（限流）与 §1（环境变量）。非破坏性变更。
