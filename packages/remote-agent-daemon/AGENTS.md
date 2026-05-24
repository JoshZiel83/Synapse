# remote-agent-daemon

机器侧守护进程：把外部 coding agent（Claude Code、Codex，未来可加其他 Agent SDK）桥接进 Synapse conversation。

## 架构约定

- **per-(remote_agent, conversation) runtime session**：一个 remote_agent 在不同 Synapse conversation 中必须对应不同的 CC/Codex session，不允许复用同一个 `session_id` / `threadId`。运行时状态在 server 端落 `remote_agent_conversation_contexts`（含 `runtime_session_id`、`runtime_state` 等列），daemon 端按 `Map<conversationId, ConversationRuntime>` 管理。**不要再把 sessionId 挂在 binding 上**。
- **driver 抽象**：所有 runtime（CC、Codex、未来新增 SDK）实现 `drivers/types.ts` 的 `AgentDriver` / `AgentSession` 接口，集中在 `drivers/registry.ts` 注册。新增 runtime 只新增一个 driver 文件 + 注册一行；不要在 supervisor 里写 runtime-specific 分支。
- **Claude Code** 走 `@anthropic-ai/claude-agent-sdk`（不直接 spawn `claude` CLI 解析 stream-json）。Permission / AskUserQuestion / ExitPlanMode 通过 SDK 的 `canUseTool` 回调路由。
- **Codex** 沿用 `codex app-server` JSON-RPC v2 over stdio（v2 typed schema 由 `codex app-server generate-ts --out src/codex/generated/` 生成、提交进 git；与本地 `codex` 二进制版本绑定，升级 codex 时需要重生成）。运行时配置 `approval_policy=never` + `sandbox_mode=workspace-write`，绝大多数 approval RPC 不再到达 driver。
- **反向 MCP**：daemon 不再托管自己的 stdio MCP server。Synapse 在 `/api/v1/internal/remote-agents/:id/mcp/:conversationId` 暴露 Streamable HTTP MCP server（IM 工具 + conversation 授权的 plugin/relay 工具）；daemon 通过 driver 的 `setMcpServers` 注入 URL + Bearer。

## 提交章法（refactor 进行中）

整改分 7 个 phase 提交，每个 phase 完成后保证 `npm run build` + 涉及 workspace 的 `npm test` 通过：

1. `chore(remote-agent): baseline before refactor`
2. `feat(remote-agent): per-conversation runtime sessions + connection fencing`
3. `feat(remote-agent): reliable delivery retry with exponential backoff`
4. `refactor(remote-agent): introduce AgentDriver abstraction + claude-agent-sdk`
5. `refactor(remote-agent): codex app-server v2 typed schema + slimmer approvals`
6. `feat(remote-agent): expose per-conversation MCP server to remote agents`
7. `test(remote-agent): isolated docker-compose stack for e2e verification`

## E2E 验证

合入 dev 后,使用 dev 分支的独立部署测试容器(`packages/api/tests/integration/` 下的 `docker-compose.test.yaml` 等)进行验证。

子进程的外发流量由部署环境的代理配置决定。如果需要让 CC/Codex 子进程走 HTTPS 代理,可以通过 `--proxy-url`(或环境变量 `SYNAPSE_AGENT_PROXY_URL`)注入,driver 内部由 `drivers/proxy-env.ts:buildAgentChildEnv()` 统一展开为 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` 系列变量。默认不开启代理。
