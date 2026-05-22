# Staging 部署速查

每个 worktree 都可以并行起一份 staging 栈，互相隔离（compose 项目名、容器名、端口、卷全部按 worktree slug 后缀化）。

## 起飞

```bash
# 在 worktree 根目录执行（注意是 source，不是 exec）
source infrastructure/scripts/staging-env.sh

# 一键构建 + 启动 + bootstrap DB + seed + smoke：
./infrastructure/scripts/redeploy-staging.sh
# 后续重建只需要：
./infrastructure/scripts/redeploy-staging.sh --skip-seed
# 彻底清盘重来：
./infrastructure/scripts/redeploy-staging.sh --reset
```

完成后 staging 端口写在 `.env.staging.local`，访问入口：

- 桌面 web：`http://127.0.0.1:${NGINX_PORT}/`
- 移动 web：`http://127.0.0.1:${NGINX_PORT}/mobile/`
- API：`http://127.0.0.1:${NGINX_PORT}/api/v1/health`

## 拆掉

```bash
./infrastructure/scripts/teardown-staging.sh
# 想保留分配的端口（不重新分配）：
./infrastructure/scripts/teardown-staging.sh --keep-env
```

## 看看本机谁在跑什么

```bash
./infrastructure/scripts/list-staging.sh
```

## 跑测试

```bash
source infrastructure/scripts/staging-env.sh

# API 黑盒集成测试（针对 staging API）
STAGING_API_URL="http://127.0.0.1:${NGINX_PORT}/api/v1" \
  npm run test:integration -w packages/api

# 浏览器 E2E（指向 staging，运行在 Playwright 官方 Docker 镜像里——宿主机不需要装浏览器）
./infrastructure/scripts/run-e2e.sh                 # web + mobile 两个 project
./infrastructure/scripts/run-e2e.sh --project=web   # 只跑桌面
./infrastructure/scripts/run-e2e.sh --project=mobile
```

## 注意

- `source staging-env.sh` 会污染当前 shell 的 `JWT_*` / `POSTGRES_PASSWORD` 等环境变量。如果之后想用 `docker compose --profile production ...` 操作 prod，开一个新 shell。
- staging 端口段是 `[15000, 15999]`；分配用 `flock` 互斥，多 worktree 并发起飞不会抢同一端口。
- `MEMORY_ALLOW_RUNTIME_MODEL_DOWNLOAD=false` 默认关，所以 staging health 是 `degraded`（DB/Redis/schema 正常即可）。
- 需要外网访问 `provider-specific AI endpoint` 的服务走容器内 `HTTPS_PROXY=http://socks-bridge:8118`，sidecar 转 socks5 到 host 1080。
