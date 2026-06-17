import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, "..", "..", "..", "..", "..")
const scannedSourceRoots = [
  "packages/api/src",
  "packages/device-runtime/src",
  "packages/remote-agent-daemon/src",
  "packages/shared/src",
] as const

const classifiedJsonParseFiles = {
  businessJsonRepoExit: {
    "packages/api/src/modules/audit/repo.ts":
      "Audit log details DB JSON is decoded at repo exit.",
    "packages/api/src/modules/automation/repo.ts":
      "Automation rule, trigger, source, occurrence, and integration DB JSON is decoded at repo exit.",
    "packages/api/src/modules/context/repo.ts":
      "Context archive-point/frame DB JSON is decoded at repo exit.",
    "packages/api/src/modules/files/repo.ts":
      "File asset origin details DB JSON is decoded at repo exit.",
    "packages/api/src/modules/im/service/repo.ts":
      "IM transport account/link/session DB JSON is decoded at repo exit.",
    "packages/api/src/modules/mcp-plugins/repo.ts":
      "MCP plugin catalog, auth spec, and manifest DB JSON is decoded at repo exit.",
    "packages/api/src/modules/memory/repo.ts":
      "Memory item metadata DB JSON is decoded at repo exit.",
    "packages/api/src/modules/model-groups/repo.ts":
      "Model group policy, feature, and provider-option DB JSON is decoded at repo exit.",
    "packages/api/src/modules/organization/repo.ts":
      "Organization actor docs/package DB JSON is decoded at repo exit.",
    "packages/api/src/modules/runtime-authorizations/repo.ts":
      "Runtime authorization grant policy and source request args DB JSON is decoded at repo exit.",
    "packages/api/src/modules/session/repo.ts":
      "Session runtime read-model DB JSON payloads are decoded at repo exit.",
    "packages/api/src/modules/tasks/repo.ts":
      "Task payload and runtime authorization DB JSON is decoded at repo exit.",
    "packages/api/src/modules/tool-call-tasks/repo.ts":
      "Tool-call task payload and output chunk DB JSON is decoded at repo exit.",
    "packages/api/src/modules/workspace/repo.ts":
      "Workspace template docs DB JSON is decoded at repo exit.",
  },
  appPresentationCodec: {
    "packages/api/src/modules/ai/session-tools-input-codec.ts":
      "AI session tool JSON-string inputs are app/tool input codec payloads.",
    "packages/api/src/modules/files/upload-origin-codec.ts":
      "Multipart upload origin is an app-facing presentation input codec.",
    "packages/api/src/modules/mcp-plugins/feishu/client.ts":
      "Feishu provider responses and tool JSON-string inputs are provider/tool adapter payloads.",
    "packages/shared/src/automation/rule-contract.ts":
      "Automation rule draft JSON strings are app-input helper payloads.",
    "packages/shared/src/chat-socket/index.ts":
      "Chat websocket client frame parsing is app/client transport payload.",
    "packages/shared/src/utils/json.ts":
      "Shared JSON object helpers support boundary codecs with object-only coercion.",
  },
  wireProviderProtocolCodec: {
    "packages/api/src/infrastructure/events/codec.ts":
      "Redis system-event frames are internal protocol payloads.",
    "packages/api/src/infrastructure/websocket/asr-client-frame.ts":
      "ASR websocket client frames are wire payloads.",
    "packages/api/src/infrastructure/websocket/auth-session-control.ts":
      "Auth-session websocket control frames are internal protocol payloads.",
    "packages/api/src/infrastructure/websocket/client-frame.ts":
      "Chat websocket client frames are wire payloads.",
    "packages/api/src/modules/asr/protocol.ts":
      "ASR protocol messages are wire payloads.",
    "packages/api/src/modules/auth/better-auth.ts":
      "Better Auth Feishu OAuth responses are provider payloads.",
    "packages/api/src/modules/automation/provider-response-codec.ts":
      "Automation GitHub/GitLab API responses are provider payloads.",
    "packages/api/src/modules/devices/dispatch.ts":
      "Device runtime JSON-RPC responses are internal wire payloads.",
    "packages/api/src/modules/im/connectors/dingtalk/response-codec.ts":
      "DingTalk HTTP provider responses are provider payloads.",
    "packages/api/src/modules/im/connectors/dingtalk/stream-codec.ts":
      "DingTalk stream messages are provider wire payloads.",
    "packages/api/src/modules/im/connectors/feishu/content-codec.ts":
      "Feishu message content is provider-owned payload.",
    "packages/api/src/modules/im/connectors/qq/gateway-codec.ts":
      "QQ gateway websocket frames are provider wire payloads.",
    "packages/api/src/modules/im/connectors/qq/response-codec.ts":
      "QQ HTTP provider responses are provider payloads.",
    "packages/api/src/modules/im/connectors/wecom/outbound-router-codec.ts":
      "WeCom outbound router Redis frames are internal protocol payloads.",
    "packages/api/src/modules/im/connectors/weixin/outbound-codec.ts":
      "Weixin outbound HTTP responses are provider payloads.",
    "packages/api/src/modules/im/connectors/weixin/qr-login-codec.ts":
      "Weixin QR login HTTP responses are provider payloads.",
    "packages/api/src/modules/im/connectors/weixin/client.ts":
      "Weixin long-poll HTTP provider responses are provider payloads.",
    "packages/api/src/modules/mcp-plugins/builtin/z-ai/toolkit/zhipu-errors.ts":
      "Zhipu provider error responses are provider payloads.",
    "packages/api/src/modules/mcp-plugins/feishu/auth.ts":
      "Feishu CLI auth provider responses are provider payloads.",
    "packages/api/src/modules/mcp-plugins/mcp-stdio-client.ts":
      "Stdio MCP entryPoint JSON is plugin protocol config.",
    "packages/api/src/modules/mcp-plugins/mijia/http.ts":
      "Mijia sidecar HTTP responses are provider/internal protocol payloads.",
    "packages/api/src/modules/mcp-plugins/plugin-auth-connections.ts":
      "Plugin OAuth provider responses are provider payloads.",
    "packages/api/src/modules/mcp-plugins/runtime-control-plane.ts":
      "MCP runtime command/reply frames are internal protocol payloads.",
    "packages/api/src/modules/mcp-plugins/transports/entrypoint.ts":
      "Remote MCP entryPoint JSON is plugin protocol config.",
    "packages/device-runtime/src/api-response-codec.ts":
      "Device-runtime API responses are machine/app boundary payloads.",
    "packages/device-runtime/src/builtins/browser.ts":
      "Browser CDP target and response frames are provider/local protocol payloads.",
    "packages/device-runtime/src/builtins/one-shot-fs-helper.ts":
      "One-shot filesystem helper stdout frames are local JSON-RPC payloads.",
    "packages/device-runtime/src/builtins/ripgrep-runner.ts":
      "Ripgrep subprocess stdout frames are local protocol payloads.",
    "packages/device-runtime/src/mcp-host-codec.ts":
      "In-memory MCP host HTTP bodies are local JSON-RPC payloads.",
    "packages/device-runtime/src/sidecar-codec.ts":
      "CUA sidecar stdout frames are local JSON-RPC payloads.",
    "packages/device-runtime/src/transport.ts":
      "Device control-plane websocket frames are Synapse wire payloads.",
    "packages/remote-agent-daemon/src/api-client.ts":
      "Remote-agent daemon API responses are machine protocol payloads.",
    "packages/remote-agent-daemon/src/drivers/codex-json-rpc-codec.ts":
      "Codex driver stdout frames are local JSON-RPC payloads.",
    "packages/remote-agent-daemon/src/server-message-codec.ts":
      "Remote-agent websocket server messages are Synapse machine wire payloads.",
  },
  internalCacheLocalState: {
    "packages/api/src/modules/im/connectors/dingtalk/registration-session-store.ts":
      "DingTalk registration Redis session state is connector-local cache.",
    "packages/api/src/modules/im/connectors/qq/latest-inbound-store.ts":
      "QQ latest inbound Redis state is connector-local cache.",
    "packages/api/src/modules/im/connectors/qq/ref-index.ts":
      "QQ ref-index Redis state is connector-local cache.",
    "packages/api/src/modules/im/connectors/qq/reply-quota.ts":
      "QQ reply reservation Redis state is connector-local cache.",
    "packages/api/src/modules/im/connectors/qq/session-store.ts":
      "QQ websocket session Redis state is connector-local cache.",
    "packages/api/src/modules/im/connectors/weixin/qr-session-store.ts":
      "Weixin QR login Redis state is connector-local cache.",
    "packages/api/src/modules/mcp-plugins/instance-manager.ts":
      "MCP runtime lease metadata is internal Redis/cache state.",
    "packages/api/src/modules/memory/embedding-cache-codec.ts":
      "Memory embedding vectors are internal Redis/cache state.",
    "packages/api/src/modules/session/runtime-cache-codec.ts":
      "Session actor runtime snapshot is internal cache/presentation state.",
    "packages/device-runtime/src/broker-codec.ts":
      "Device identity and keystore files are runtime-local file state.",
  },
  configImportBootstrapAdapter: {
    "packages/api/src/infrastructure/database/seed-metadata-codec.ts":
      "Seed metadata is bootstrap/config input.",
    "packages/api/src/infrastructure/http/json-body-parser.ts":
      "Fastify request body parsing is an HTTP adapter boundary.",
    "packages/api/src/modules/ai/audio-fallback-config.ts":
      "Sherpa ONNX fallback settings are environment config.",
    "packages/api/src/modules/sandbox/host-provider.ts":
      "synapse-device pair stdout is CLI adapter output.",
    "packages/api/src/modules/skills/mirror-import-codec.ts":
      "Skill mirror metadata and GitHub responses are import-adapter payloads.",
    "packages/device-runtime/src/terminal/manifest.ts":
      "Toolchain manifest JSON is local configuration input.",
  },
} as const

function flattenClassifications(): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const files of Object.values(classifiedJsonParseFiles)) {
    for (const [file, reason] of Object.entries(files)) {
      assert.equal(
        entries[file],
        undefined,
        `${file} is classified more than once`
      )
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
  return source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
}

function toRelativeRepoPath(path: string): string {
  return relative(repoRoot, path).split(sep).join("/")
}

test("boundary production JSON.parse surfaces stay on the classified finite list", () => {
  const scannedFiles = scannedSourceRoots.flatMap((sourceRoot) =>
    sourceFiles(join(repoRoot, sourceRoot))
  )
  const filesWithJsonParse = scannedFiles
    .filter((path) =>
      /\bJSON\s*\.\s*parse\s*\(/.test(stripComments(readFileSync(path, "utf8")))
    )
    .map(toRelativeRepoPath)
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

test("boundary production code does not use unchecked Response.json parsers", () => {
  const filesWithResponseJson = scannedSourceRoots
    .flatMap((sourceRoot) => sourceFiles(join(repoRoot, sourceRoot)))
    .filter((path) =>
      /\b(?:r|res|resp|response)\s*\.\s*json\s*\(/.test(
        stripComments(readFileSync(path, "utf8"))
      )
    )
    .map(toRelativeRepoPath)
    .sort()

  assert.deepEqual(filesWithResponseJson, [])
})
