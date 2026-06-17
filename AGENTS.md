当前系统处于初期设计实现阶段，不要考虑兼容旧数据。

## 系统分层架构（DB / DTO / Wire 边界）

> 完整背景与执行计划见 [docs/architecture-boundary-refactor-master-plan.md](./docs/architecture-boundary-refactor-master-plan.md)。
> 本节是**编码时必须遵守的规范**；guard 脚本会强制其中可机检的条目。

### 三个命名世界，由「层」决定，不由「包」决定

- **PostgreSQL = snake_case**：物理表/列保持 snake_case，是持久化真源。
- **TypeScript 业务层 = camelCase**：Kysely 装了 `CamelCasePlugin({ maintainNestedObjectKeys: true })`，row 在 TS 侧顶层标识符全部 camelCase（`row.workspaceId`，不是 `row.workspace_id`）。
- **Wire / machine = snake_case**：`packages/device-protocol` 的签名封套、pairing、control-plane、reverse-MCP 故意保持 snake_case；这些 key 参与 Ed25519 签名规范化，**绝不能改名**。

snake_case 出现在两种地方：(a) DB 物理层与 device-protocol wire 契约——**合法**；(b) `packages/api/src/modules/**` 的 service/controller 或 `packages/web-next` 的组件里——**禁止**，那是 DB row 泄漏。

### 七层职责（modules/<feature>/ 内）

| 层           | 文件                        | 只能做                                                                      | 禁止                                                                   |
| ------------ | --------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| repo         | `repo.ts` / `repo.types.ts` | SQL、join、projection、business JSON 解码(Zod)；产出 `XxxRecord`(camelCase) | 输出 app DTO / wire payload                                            |
| service      | `service.ts`                | 业务流程、用例编排                                                          | import `generated/db`、用 `TableRow`、拼 HTTP envelope、做 wire 序列化 |
| presenter    | `presenter.ts`              | 域记录 → app DTO；`Date→IsoInstantString`、`fileId→URL`、显示派生           | SQL、事务、业务前置 JSON 校验、wire payload                            |
| wire-adapter | `wire.ts`                   | 域记录 ↔ snake_case wire；用 device-protocol schema；签名/裸 payload 组装   | SQL、业务流程、app DTO                                                 |
| controller   | `controller.ts`             | zod parse → service → presenter/wire → 发送                                 | 直接访问 row                                                           |
| schemas      | `schemas.ts`                | 路由本地 zod（path/query 拼装）                                             | 重新定义对外契约类型——app 请求体/响应 DTO 均 import 自 shared          |
| index        | `index.ts`                  | `fastify-plugin` + `app.register(controller, { prefix })`                   | 业务逻辑                                                               |

> **service 调 `present*` 的判定（避免被反复误报为"未收口"）**：service 层被禁的是"**拼对外 HTTP 响应 DTO 并交给 controller 裸发**"——即 service 直接产出某个 `XxxView` 作为 HTTP body 的唯一来源。**允许**的 `present*` 调用有三类，它们不是违规：(a) **行→域记录 / 记录装配** 映射（如 `presentFileAsset`→`StoredFileRecord`、`presentActorRow`→`Actor`、`presentUser`→`User`——产出在 api 内部流转的 `XxxRecord` 域记录，被本模块业务逻辑或装配进更大记录使用）；(b) **薄时间包装** `presentInstant` / `presentOptionalInstant`（presenter 拥有的字段级序列化 helper，可在记录装配处调用）；(c) **跨模块消费的记录**（被其它模块或 worker import 并按记录形态读取，如 automation 的 `AutomationRule` 被 ai/session-tools 读、remote-agents 的 runtime snapshot 被 chat 读）。判据：present\* 的产物是否作为 **HTTP body 的唯一来源被 controller 裸发**？是→违规，移到 controller（经 `appRoute`/`sendData`）；否（域记录/跨模块/时间包装）→允许。规范的 app 出口仍是 controller 经 `appRoute`/`sendData(XxxViewSchema, …)`。

`infrastructure/**` 与 `workers/**` **不**强制套这套模板，但必须有明确 adapter 边界，可合法使用 `serializeInstant()` 等 infra helper。

### 硬规则（guard 强制）

1. **只有 `repo*.ts` / `repo.types.ts` 可以 import `generated/db` / `db-types`、可以用 `TableRow` / `TableInsert` / `TableUpdate`。** service / controller 一律禁止。
2. **`map*Row` / `normalize*Row` 只能写在 `repo*.ts` 内。** 业务层不再手写机械改名（`CamelCasePlugin` 已承担）。
3. **时间序列化（`serializeInstant` / `serializeOptionalInstant`）只在 presenter 或 infra adapter。** service / controller 禁止直接调用。
4. **禁止双命名兜底**（`row.foo_bar || row.fooBar`）与**对外 `...row` spread**。
5. **对外契约真源，按「层/角色」划而非「资源」划**：app-facing camelCase 类型(`XxxView`)定义在 `packages/shared/src/schemas/<feature>.ts`（schema-first + `types/` type-only re-export）；wire snake_case 类型(`XxxWire`)定义在 `packages/device-protocol`。同一资源的"读视图"归 shared、"握手/签名协议"归 device-protocol（如 device）。`packages/api` 只 import 并翻译，**不**私自定义对外契约真源。
6. **同一对象禁止混用两种命名**（不允许 `{ workspaceId, device_capability_ids }` 这种）。
7. 依赖方向：`shared → device-protocol`（单向）；`device-protocol` 不得 import `shared`；`shared` 不得 import `api`。
8. **`packages/shared/src/types/**`禁止`export const|function|class`**（只能 `export type`/`import type`）；runtime 常量/函数归 `constants/` 等子路径。
9. **`packages/device-protocol` 禁止纯前端展示字段**（如 `one_click_commands` / `verification_uri_complete`，归 shared `DevicePairingTicketView`）；只保留握手/签名 wire 字段。`bootstrap_token` 是合法 wire 握手字段，不在此列。

### 响应封套与 route surface

- **app surface 端点**：有返回体的统一走 `sendData(reply, XxxViewSchema, dto)` → `{ data: ... }`。禁止裸 `reply.send(serviceResult)`。**`/auth/me` 等自定义 app 端点属此类**，不因挂在 `/auth/*` 下就豁免；device 的 list/detail 读视图也属此类（camelCase `DeviceView`）。
- **无返回体的写端点保留 204 No Content**（如 device 的 delete/detach/set-capabilities），不强行套 `{ data }`；`sendData` 只覆盖有返回体的端点。
- **app surface 的请求体/查询 DTO 也是 app 契约**：`XxxInput`/`XxxRequest` 定义在 `shared/src/schemas/` camelCase，与 `XxxView` 成对；controller 用它 parse，前端/SDK 发 camelCase body，不再手拼 snake_case（wire 端点请求体仍由 device-protocol snake_case 定义）。
- **wire/machine surface 端点保持裸 payload，禁止套 `{ data }`**（否则破坏 device-sdk/daemon）。真 wire 仅：device 握手（`/devices/bootstrap`、`/devices/pairing-sessions/consume`、control-plane WSS、signed envelope）、machine-key 路由与 reverse-MCP `/api/v1/internal/*`、`/auth/device/*`(RFC 8628)、`/mcp/auth/callback`、`/im/webhooks/*`、`/automation-webhooks/*`、better-auth wildcard 原生透传、`/install.{sh,ps1}`。
- **app vs wire 用显式机制判定，不靠路径前缀**：mixed 模块（automation/im/mcp-plugins/remote-agents/runtime-authorizations/files/devices）用 **split-controller**（`controller.app.ts` 只 `sendData`、`controller.wire.ts` 只裸 payload）或 **route marker**（`appRoute()`/`wireRoute()`）；mixed 模块禁止裸 `app.get/post(...)`。guard 据文件名/注册 helper 强制，不维护逐端点白名单。
- **device-sdk 是 mixed consumer SDK**：管理面方法（list/get/create/pair/claim/detach/set-capabilities）走 app（shared camelCase + `{ data }`/204）；只有 `consumePairing` / cloud bootstrap / control-plane 是 wire。不要把它整体当 wire 侧。

### JSON 列三分类

- **Business JSON**（如 `runtime_authorization_grants.policy`、`sessions.collaboration_state`）：在 **repo 出口用 Zod 解码**，service 拿到即域类型；不要在 service 散装 `JSON.parse`。
- **Presentation JSON**（如 `*.content_blocks`）：在 presenter / canonical codec 处理。
- **Wire / 签名 JSON**（如签名封套片段、`*.payload`、`source_snapshot`）：走**显式 wire codec**，绝不隐式改名。
- **Opaque passthrough**（MCP `_meta`、`provider_options`、`secret_payload`、通用 `metadata`）：原样存取，`maintainNestedObjectKeys:true` 保证 plugin 不递归改写。
- JSON 解析复用 `@synapse/shared` 的 `parseJsonObject` / `parseJsonObjectOrUndefined`；不要再写 `asObject` / `asRecord` 散装副本（有意抛错的 business 解码器除外）。

## 业务枚举与分支判断规范

- 跨 `packages/api`、`packages/web-next`、`packages/mobile-app` 共享的业务枚举与协议值，统一定义在 `packages/shared`，禁止在消费端重复声明同义字符串联合或手抄枚举数组。
- 业务分支判断禁止直接写原始业务字符串字面量，例如 `participant.type === "actor"`、`status === "pending_approval"`、`z.enum(["workspace_open", "approval_required"])` 这类写法不再允许。
- 统一写法为 shared 常量成员比较，例如 `participant.type === CONVERSATION_PARTICIPANT_TYPE.ACTOR`，以及 `z.enum(RELATIONSHIP_ACCESS_POLICIES)`。
- 共享业务枚举统一使用 `const object + values tuple + 派生 type` 模式；不要只写裸联合类型。
- 数据库已有 enum 的业务值，以 `packages/shared` 为应用层真源，`packages/api/src/infrastructure/database/enum-compat.ts` 负责与 DB 生成类型做编译期对齐。
- 纯 UI 文案、临时交互状态、展示 label、样式 key 不纳入这一条；但文案选择逻辑里涉及业务枚举时，仍必须使用 shared 常量。

## 日志与可观测性（Logging & Observability）

完整方案见 `docs/logging-refactor/`（00 现状 / 01 方案 / 02 建议 / 03 决策）。核心约定：

- **唯一 logger，禁止两套并行实现**。`packages/api` 用 pino，单例在 `src/infrastructure/logger/index.ts`，并经 `Fastify({ logger })` 同时作请求 logger（app 日志 == 请求日志，绝不再起第二个 pino 实例）。该模块**禁止依赖 config**（它直接读 `process.env.LOG_LEVEL/NODE_ENV`，否则与 config 校验形成启动环）。
- **业务 domain 标识（可靠日志标识）**。每条日志带结构化 `domain`（封闭枚举 `LOG_DOMAINS`）+ 可选 `component`，由 `createLogger(scope)` 工厂侧查表 `SCOPE_TO_DOMAIN` 派生。调用面保持 `createLogger("im.qq")` 写法不变；**新增 scope 必须在 `SCOPE_TO_DOMAIN` 加一行**，否则 `guard:logging` 失败。`domain` 是 Loki 的低基数 label，所有高基数关联 id（trace_id/reqId/sessionId/…）只进 JSON body，绝不作 label。
- **关联（correlation）**。OpenTelemetry：`src/instrumentation.ts` 作为 `src/index.ts` 的**第一个 import** 初始化（HTTP 埋点须在建服务器前生效）。trace_id/span_id 由 `infrastructure/logger` 的 pino `mixin` 实时从活动 span 注入每行日志（不依赖模块 patch）。Fastify `genReqId` 对齐 trace_id。**BullMQ 跨 Redis** 用 `workers/job-tracing.ts`：`queues.ts` 在每次 `.add` 注入 trace context，worker 必须用 `tracedWorker(...)`（**禁止 `new Worker`**）以续接 trace。
- **导出全部 env 驱动、零硬编码**（开源仓库要求）：`OTEL_EXPORTER_OTLP_ENDPOINT`（→ Alloy/Tempo）、`OTEL_SERVICE_NAME`、`SENTRY_DSN`/`SENTRY_ENVIRONMENT`/`SENTRY_TRACES_SAMPLE_RATE`。Sentry 经 `@sentry/opentelemetry` 作为 span processor 融入同一 provider（一个 trace 同时进 Tempo + Sentry）。
- **stdout 对行协议面神圣**：device-runtime sidecars / daemon / Go·Rust·Python sidecar 的 stdout 专给 JSON-RPC/MCP，所有日志走 **stderr**。
- **治理**：`scripts/guard-logging.mjs`（`guard:logging`，注册于 `pretest` 与 `verify-boundary.sh`）禁止新增裸 `console.*`（既有按 `scripts/guard-logging-baseline.json` 的 per-file 计数 grandfather，只降不增；迁移某文件后用 `--write-baseline` 重新快照），并强制每个 `createLogger` scope 映射到 domain 分类。
- **聚合**：自托管 `observability` profile（Loki + Tempo + Alloy + Grafana），docker-compose 每个 service 已配 json-file 轮转。

## Docker 生产部署约定

- 生产环境以 `docker compose --profile production` 为统一部署入口，不再以宿主机 `systemd` 管理 API、桌面 Web 或移动 Web 进程。
- 可选 sidecar 用独立 profile 叠加：私有 npm registry 用 `registry`；Mijia 米家 MCP sidecar 用 `mijia`（内网专用，凭据按请求经 header 传入，不读 `.env`），例如 `docker compose --profile production --profile mijia up -d --build mijia-mcp api`。详见 deploy.md §5c 与 `sidecars/mijia-mcp/UPSTREAM.md`。
- 修改任何会影响生产运行的代码、配置、数据库访问、权限逻辑、前端构建产物或 nginx 路由后，都需要重新构建并拉起对应 Compose 服务，不能只假设热更新或旧容器会自动生效。
- 常用检查命令：
  - `docker compose --profile production ps`
  - `docker compose --profile production --profile tls ps`
  - `docker compose --profile production --profile http ps`
  - `docker compose --profile production logs --tail=100 api`
  - `docker compose --profile production logs --tail=100 web`
  - `docker compose --profile production logs --tail=100 mobile-web`
  - `docker compose --profile production logs --tail=100 nginx`

## Backend 更新与重启

- 修改 `packages/api`、`packages/shared` 中会影响后端运行时行为的代码，或修改 API 相关环境变量、数据库访问、权限逻辑后，需要重新构建并重启 API 容器。
- 重启命令：
  - `docker compose --profile production up -d --build api`
- 重启后必须检查容器状态和健康接口：
  - `docker compose --profile production ps api`
  - `curl -sS http://127.0.0.1:3001/api/v1/health`

## Mobile Web 部署约定

- `packages/mobile-app` 的 web 版本不是直接由 nginx 反代 dev server，而是作为静态站部署。
- 线上 nginx 将手机端 web 挂在子路径 `/mobile`。
- 桌面端 web 继续走根路径 `/`，由 nginx 反代 `packages/web-next`。
- 移动端静态站由 `mobile-web` 容器内的 nginx 提供，配置在 `infrastructure/nginx/mobile-web.conf`。
- TLS 公网入口由 `nginx` 容器提供，模板配置在 `infrastructure/nginx/public.conf.template`，真实域名从本机 `.env` 注入。
- HTTP-only 公网入口由 `nginx-http` 容器提供，模板配置在 `infrastructure/nginx/public-http.conf.template`，用于纯 IP/端口部署，不启用证书、不监听 443、不跳转 HTTPS。
- `${SYNAPSE_MOBILE_SHORT_DOMAIN}` 与 `${SYNAPSE_MOBILE_DOMAIN}` 的根路径会跳转到 `/mobile/`。

## Mobile Web 构建与发布

- `packages/mobile-app` 已配置 `expo.experiments.baseUrl = "/mobile"`，所以生产部署必须走静态导出。
- `packages/mobile-app/public/chat-service-worker.js` 是构建产物，源码在 `packages/mobile-app/src/workers/chat-service-worker.ts`；不要直接手改生成后的 worker 文件。
- 修改任何会影响 mobile web 的代码、资源、HTML 壳层、路由或 service worker 后，都需要重新构建 `mobile-web` 镜像，不能只重启 `expo start --web`。
- 如果修改了 mobile web chat service worker 或其依赖的存储代码，需要先重新构建 worker：
  - `cd packages/mobile-app`
  - `npm run build:chat-worker`
- 生产构建与发布命令：
  - TLS: `docker compose --profile production --profile tls up -d --build mobile-web nginx`
  - HTTP-only: `docker compose --profile production --profile http up -d --build mobile-web nginx-http`
- 如果公网 nginx 配置有变更，需要重建或重启 `nginx` 容器：
  - TLS: `docker compose --profile production --profile tls up -d --force-recreate nginx`
  - HTTP-only: `docker compose --profile production --profile http up -d --force-recreate nginx-http`

## 额外说明

- `expo start --web` 仅用于本地开发调试，不能代表线上 `/mobile` 的真实部署行为。
- 线上 mobile web 的静态目录在 `mobile-web` 容器内为 `/usr/share/nginx/html/mobile`，由镜像构建生成。
- `/mobile` 的聊天 service worker、`_expo` 资源、`favicon` 等都依赖静态导出结果，所以这类改动后必须重新构建并发布 `mobile-web` 镜像。

## Desktop Web 构建与重启

- 公网桌面端 web 根路径 `/` 不是直接暴露 `next dev`，而是由 `web` 容器运行 `packages/web-next` 的 production build。
- 修改 `packages/web-next` 或任何会影响桌面端 web 运行结果的共享前端代码、资源、样式、路由、metadata、`public` 文件后，不能只看 dev server；必须重新构建前端镜像并重启 `web` 容器。
- 重启命令：
  - TLS: `docker compose --profile production --profile tls up -d --build web nginx`
  - HTTP-only: `docker compose --profile production --profile http up -d --build web nginx-http`
- 重启后必须检查服务状态，确认新的前端构建产物已经成功加载：
  - `docker compose --profile production --profile tls ps web nginx`
  - `docker compose --profile production --profile http ps web nginx-http`
  - `curl -I http://127.0.0.1:3000`
- 如果需要手动验证 production 构建是否能通过，优先运行：
  - `npm run build -w packages/web-next`
- 如果只是远程调试开发态页面，可按需运行 `npm run dev -w packages/web-next` 并通过 SSH 隧道访问本地端口，但这不能代表公网 `/` 的最终效果。

## TLS 证书与续期

- 生产证书由 Dockerized Certbot 管理，证书卷挂载到公网 `nginx` 容器。
- `SYNAPSE_DEPLOY_MODE=http` 不使用证书；不要运行 `issue-cert.sh`，也不需要安装证书续期 cron。
- 首次签发命令：
  - `./infrastructure/scripts/issue-cert.sh`
- 续期命令：
  - `./infrastructure/scripts/renew-cert.sh`
- 续期 cron 模板在 `infrastructure/cron/synapse-certbot-renew.template`，安装时由 `deploy.md` 中的 `sed` 命令把 `__REPO_ROOT__` 替换为当前仓库根目录后写入 `/etc/cron.d/`。
- 公网 nginx 已启用 OCSP stapling；证书变更后需要 reload nginx：
  - `docker compose --profile production --profile tls exec -T nginx nginx -s reload`

## Web Chat Worker 构建

- `packages/web-next/public/web-chat-service-worker.js` 是构建产物，源码在 `packages/web-next/lib/workers/web-chat-service-worker.ts`；不要直接修改生成后的 worker 文件。
- 修改 `packages/web-next` 的 chat service worker 或其依赖的 IndexedDB/queue 存储代码后，需要重新生成 worker：
  - `npm run build:chat-worker -w packages/web-next`
- `packages/web-next` 已配置：
  - `npm run dev -w packages/web-next` 前会自动执行 `build:chat-worker`
  - `npm run build -w packages/web-next` 前会自动执行 `build:chat-worker`
- 如果只是手动验证 worker 产物是否最新，优先直接运行 `npm run build:chat-worker -w packages/web-next`。
