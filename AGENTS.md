当前系统处于初期设计实现阶段，不要考虑兼容旧数据。

## Backend 更新与重启

- 修改 `packages/api` 或任何会影响后端运行时行为、配置加载、数据库访问、权限逻辑的代码后，需要通过 `systemctl` 重启后端服务，不能只假设热更新或旧进程会自动生效。
- 后端服务名为 `synapse-api.service`。
- 重启命令：
  - `sudo systemctl restart synapse-api.service`
- 重启后必须检查服务状态，确认服务已经成功拉起且处于正常运行状态。
- 状态检查命令：
  - `systemctl is-active synapse-api.service`
  - `systemctl --no-pager --full status synapse-api.service`

## Mobile Web 部署约定

- `packages/mobile-app` 的 web 版本不是直接由 nginx 反代 dev server，而是作为静态站部署。
- 线上 nginx 将手机端 web 挂在子路径 `/mobile`。
- 桌面端 web 继续走根路径 `/`，由 nginx 反代 `packages/web-next`。
- mobile web 的 nginx 配置模板在 `infrastructure/nginx.conf`，线上生效配置是 `/etc/nginx/sites-available/synapse.conf`。

## Mobile Web 构建与发布

- `packages/mobile-app` 已配置 `expo.experiments.baseUrl = "/mobile"`，所以生产部署必须走静态导出。
- `packages/mobile-app/public/chat-service-worker.js` 是构建产物，源码在 `packages/mobile-app/src/workers/chat-service-worker.ts`；不要直接手改生成后的 worker 文件。
- 修改任何会影响 mobile web 的代码、资源、HTML 壳层、路由或 service worker 后，都需要重新导出 web 产物，不能只重启 `expo start --web`。
- 如果修改了 mobile web chat service worker 或其依赖的存储代码，需要先重新构建 worker：
  - `cd packages/mobile-app`
  - `npm run build:chat-worker`
- 导出命令：
  - `cd packages/mobile-app`
  - `npx expo export --platform web --output-dir /tmp/synapse-mobile-web-export`
- 导出完成后，需要将产物同步到 nginx 的静态目录：
  - `sudo rsync -a --delete /tmp/synapse-mobile-web-export/ /var/www/mobile/`
- 如果 nginx 配置有变更，还需要执行：
  - `sudo nginx -t`
  - `sudo systemctl reload nginx`

## 额外说明

- `expo start --web` 仅用于本地开发调试，不能代表线上 `/mobile` 的真实部署行为。
- 线上 mobile web 的静态目录固定为 `/var/www/mobile`。
- `/mobile` 的聊天 service worker、`_expo` 资源、`favicon` 等都依赖静态导出结果，所以这类改动后必须重新导出并同步。

## Web Chat Worker 构建

- `packages/web-next/public/web-chat-service-worker.js` 是构建产物，源码在 `packages/web-next/lib/workers/web-chat-service-worker.ts`；不要直接修改生成后的 worker 文件。
- 修改 `packages/web-next` 的 chat service worker 或其依赖的 IndexedDB/queue 存储代码后，需要重新生成 worker：
  - `npm run build:chat-worker -w packages/web-next`
- `packages/web-next` 已配置：
  - `npm run dev -w packages/web-next` 前会自动执行 `build:chat-worker`
  - `npm run build -w packages/web-next` 前会自动执行 `build:chat-worker`
- 如果只是手动验证 worker 产物是否最新，优先直接运行 `npm run build:chat-worker -w packages/web-next`。
