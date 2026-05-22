当前系统处于初期设计实现阶段，不要考虑兼容旧数据。

## 业务枚举与分支判断规范

- 跨 `packages/api`、`packages/web-next`、`packages/mobile-app` 共享的业务枚举与协议值，统一定义在 `packages/shared`，禁止在消费端重复声明同义字符串联合或手抄枚举数组。
- 业务分支判断禁止直接写原始业务字符串字面量，例如 `participant.type === "actor"`、`status === "pending_approval"`、`z.enum(["workspace_open", "approval_required"])` 这类写法不再允许。
- 统一写法为 shared 常量成员比较，例如 `participant.type === CONVERSATION_PARTICIPANT_TYPE.ACTOR`，以及 `z.enum(RELATIONSHIP_ACCESS_POLICIES)`。
- 共享业务枚举统一使用 `const object + values tuple + 派生 type` 模式；不要只写裸联合类型。
- 数据库已有 enum 的业务值，以 `packages/shared` 为应用层真源，`packages/api/src/infrastructure/database/enum-compat.ts` 负责与 DB 生成类型做编译期对齐。
- 纯 UI 文案、临时交互状态、展示 label、样式 key 不纳入这一条；但文案选择逻辑里涉及业务枚举时，仍必须使用 shared 常量。

## Docker 生产部署约定

- 生产环境以 `docker compose --profile production` 为统一部署入口，不再以宿主机 `systemd` 管理 API、桌面 Web 或移动 Web 进程。
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
- 续期 cron 模板在 `infrastructure/cron/synapse-certbot-renew`。
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
