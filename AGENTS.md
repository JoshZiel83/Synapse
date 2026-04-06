当前系统处于初期设计实现阶段，不要考虑兼容旧数据。

## Mobile Web 部署约定

- `packages/mobile-app` 的 web 版本不是直接由 nginx 反代 dev server，而是作为静态站部署。
- 线上 nginx 将手机端 web 挂在子路径 `/mobile`。
- 桌面端 web 继续走根路径 `/`，由 nginx 反代 `packages/web-next`。
- mobile web 的 nginx 配置模板在 `infrastructure/nginx.conf`，线上生效配置是 `/etc/nginx/sites-available/synapse.conf`。

## Mobile Web 构建与发布

- `packages/mobile-app` 已配置 `expo.experiments.baseUrl = "/mobile"`，所以生产部署必须走静态导出。
- 修改任何会影响 mobile web 的代码、资源、HTML 壳层、路由或 service worker 后，都需要重新导出 web 产物，不能只重启 `expo start --web`。
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
