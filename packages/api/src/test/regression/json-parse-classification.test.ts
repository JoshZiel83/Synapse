import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

const classifiedJsonParseFiles = {
  businessJsonRepoExit: {
    "modules/context/repo.ts":
      "Context archive-frame DB JSON is decoded at repo exit.",
    "modules/im/service/repo.ts":
      "IM transport account/link/session DB JSON is decoded at repo exit.",
    "modules/mcp-plugins/repo.ts":
      "MCP plugin catalog, auth spec, and manifest DB JSON is decoded at repo exit.",
    "modules/organization/repo.ts":
      "Organization actor docs/package DB JSON is decoded at repo exit.",
    "modules/session/repo.ts":
      "Session runtime read-model DB JSON payloads are decoded at repo exit.",
    "modules/tasks/repo.ts":
      "Task payload and runtime authorization DB JSON is decoded at repo exit.",
    "modules/workspace/repo.ts":
      "Workspace template docs DB JSON is decoded at repo exit.",
  },
  appPresentationCodec: {
    "modules/ai/session-tools-input-codec.ts":
      "AI session tool JSON-string inputs are app/tool input codec payloads.",
    "modules/files/upload-origin-codec.ts":
      "Multipart upload origin is an app-facing presentation input codec.",
    "modules/mcp-plugins/feishu/client.ts":
      "Feishu provider responses and tool JSON-string inputs are provider/tool adapter payloads.",
  },
  wireProviderProtocolCodec: {
    "infrastructure/events/codec.ts":
      "Redis system-event frames are internal protocol payloads.",
    "infrastructure/websocket/asr-client-frame.ts":
      "ASR websocket client frames are wire payloads.",
    "infrastructure/websocket/auth-session-control.ts":
      "Auth-session websocket control frames are internal protocol payloads.",
    "infrastructure/websocket/client-frame.ts":
      "Chat websocket client frames are wire payloads.",
    "modules/asr/protocol.ts": "ASR protocol messages are wire payloads.",
    "modules/auth/better-auth.ts":
      "Better Auth Feishu OAuth responses are provider payloads.",
    "modules/automation/provider-response-codec.ts":
      "Automation GitHub/GitLab API responses are provider payloads.",
    "modules/devices/dispatch.ts":
      "Device runtime JSON-RPC responses are internal wire payloads.",
    "modules/im/connectors/dingtalk/response-codec.ts":
      "DingTalk HTTP provider responses are provider payloads.",
    "modules/im/connectors/dingtalk/stream-codec.ts":
      "DingTalk stream messages are provider wire payloads.",
    "modules/im/connectors/feishu/content-codec.ts":
      "Feishu message content is provider-owned payload.",
    "modules/im/connectors/qq/gateway-codec.ts":
      "QQ gateway websocket frames are provider wire payloads.",
    "modules/im/connectors/qq/response-codec.ts":
      "QQ HTTP provider responses are provider payloads.",
    "modules/im/connectors/wecom/outbound-router-codec.ts":
      "WeCom outbound router Redis frames are internal protocol payloads.",
    "modules/im/connectors/weixin/outbound-codec.ts":
      "Weixin outbound HTTP responses are provider payloads.",
    "modules/im/connectors/weixin/qr-login-codec.ts":
      "Weixin QR login HTTP responses are provider payloads.",
    "modules/mcp-plugins/builtin/z-ai/toolkit/zhipu-errors.ts":
      "Zhipu provider error responses are provider payloads.",
    "modules/mcp-plugins/feishu/auth.ts":
      "Feishu CLI auth provider responses are provider payloads.",
    "modules/mcp-plugins/mcp-stdio-client.ts":
      "Stdio MCP entryPoint JSON is plugin protocol config.",
    "modules/mcp-plugins/mijia/http.ts":
      "Mijia sidecar HTTP responses are provider/internal protocol payloads.",
    "modules/mcp-plugins/plugin-auth-connections.ts":
      "Plugin OAuth provider responses are provider payloads.",
    "modules/mcp-plugins/runtime-control-plane.ts":
      "MCP runtime command/reply frames are internal protocol payloads.",
    "modules/mcp-plugins/transports/entrypoint.ts":
      "Remote MCP entryPoint JSON is plugin protocol config.",
  },
  internalCacheLocalState: {
    "modules/im/connectors/dingtalk/registration-session-store.ts":
      "DingTalk registration Redis session state is connector-local cache.",
    "modules/im/connectors/qq/latest-inbound-store.ts":
      "QQ latest inbound Redis state is connector-local cache.",
    "modules/im/connectors/qq/ref-index.ts":
      "QQ ref-index Redis state is connector-local cache.",
    "modules/im/connectors/qq/reply-quota.ts":
      "QQ reply reservation Redis state is connector-local cache.",
    "modules/im/connectors/qq/session-store.ts":
      "QQ websocket session Redis state is connector-local cache.",
    "modules/im/connectors/weixin/qr-session-store.ts":
      "Weixin QR login Redis state is connector-local cache.",
    "modules/mcp-plugins/instance-manager.ts":
      "MCP runtime lease metadata is internal Redis/cache state.",
    "modules/memory/embedding-cache-codec.ts":
      "Memory embedding vectors are internal Redis/cache state.",
    "modules/session/runtime-cache-codec.ts":
      "Session actor runtime snapshot is internal cache/presentation state.",
  },
  configImportBootstrapAdapter: {
    "infrastructure/database/seed-metadata-codec.ts":
      "Seed metadata is bootstrap/config input.",
    "infrastructure/http/json-body-parser.ts":
      "Fastify request body parsing is an HTTP adapter boundary.",
    "modules/ai/audio-fallback-config.ts":
      "Sherpa ONNX fallback settings are environment config.",
    "modules/sandbox/host-provider.ts":
      "synapse-device pair stdout is CLI adapter output.",
    "modules/skills/mirror-import-codec.ts":
      "Skill mirror metadata and GitHub responses are import-adapter payloads.",
  },
} as const

function flattenClassifications(): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const files of Object.values(classifiedJsonParseFiles)) {
    for (const [file, reason] of Object.entries(files)) {
      entries[file] = reason
    }
  }
  return entries
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry)
      const stat = statSync(path)
      if (stat.isDirectory()) return sourceFiles(path)
      if (
        !path.endsWith(".ts") ||
        path.endsWith(".test.ts") ||
        path.endsWith(".spec.ts") ||
        path.endsWith(".d.ts")
      ) {
        return []
      }
      return [path]
    })
    .sort()
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
}

function toRelativeSourcePath(path: string): string {
  return relative(srcRoot, path).split(sep).join("/")
}

test("API production JSON.parse surfaces stay on the classified finite list", () => {
  const filesWithJsonParse = sourceFiles(srcRoot)
    .filter((path) =>
      /\bJSON\s*\.\s*parse\s*\(/.test(stripComments(readFileSync(path, "utf8")))
    )
    .map(toRelativeSourcePath)
    .sort()
  const classifications = flattenClassifications()
  const classifiedFiles = Object.keys(classifications).sort()

  assert.deepEqual(filesWithJsonParse, classifiedFiles)
  assert.deepEqual(
    Object.entries(classifications).filter(
      ([, reason]) => reason.trim() === ""
    ),
    []
  )
})
