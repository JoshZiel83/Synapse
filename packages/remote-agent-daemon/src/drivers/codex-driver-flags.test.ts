import test from "node:test"
import assert from "node:assert/strict"
import { __mcpServerConfigToCodexFlagsForTest } from "./codex-driver.js"

const toFlags = __mcpServerConfigToCodexFlagsForTest as (
  servers: Record<string, any> | undefined
) => { args: string[]; env: Record<string, string> }

test("mcpServerConfigToCodexFlags returns empty when given no servers", () => {
  const out = toFlags(undefined)
  assert.deepEqual(out, { args: [], env: {} })
})

test("Authorization headers go through bearer_token_env_var, never into CLI args", () => {
  const out = toFlags({
    synapse: {
      type: "http",
      url: "http://127.0.0.1:53000/api/v1/internal/remote-agents/agent/mcp/conv",
      headers: { Authorization: "Bearer sk_machine_secret_value" },
    },
  })
  const joined = out.args.join(" ")
  assert.ok(
    !joined.includes("sk_machine_secret_value"),
    "raw bearer must not appear in CLI args (would leak via ps / audit logs)"
  )
  assert.ok(
    !joined.toLowerCase().includes("authorization"),
    "Authorization header must not be projected into http_headers"
  )
  const envName = Object.keys(out.env).find((k) =>
    k.startsWith("SYNAPSE_MCP_BEARER_")
  )
  assert.ok(envName, "an env var name should be allocated for the bearer")
  assert.equal(out.env[envName!], "sk_machine_secret_value")
  assert.ok(
    out.args.some((arg) => arg.includes(`bearer_token_env_var="${envName}"`)),
    "the -c arg must reference the env var name, not the secret"
  )
})

test("Non-Authorization headers are still passed via http_headers", () => {
  const out = toFlags({
    synapse: {
      type: "http",
      url: "http://h/m",
      headers: {
        Authorization: "Bearer t",
        "X-Trace-Id": "trace-123",
      },
    },
  })
  const httpHeadersArg = out.args
    .map((arg, index) => ({ arg, index }))
    .find(({ arg }) => arg.includes("mcp_servers.synapse.http_headers="))
  assert.ok(httpHeadersArg, "http_headers flag should still be present")
  assert.ok(
    httpHeadersArg!.arg.includes("X-Trace-Id"),
    "non-secret headers stay in http_headers"
  )
  assert.ok(
    !httpHeadersArg!.arg.toLowerCase().includes("authorization"),
    "Authorization is removed from http_headers"
  )
})

test("Per-MCP default_tools_approval_mode is set to approve so internal tools don't prompt", () => {
  const out = toFlags({
    synapse: { type: "http", url: "http://h/m" },
  })
  assert.ok(
    out.args.some((arg) =>
      arg.includes(`mcp_servers.synapse.default_tools_approval_mode="approve"`)
    )
  )
})

test("stdio servers pass command and args; no bearer env handling needed", () => {
  const out = toFlags({
    chat: {
      type: "stdio",
      command: "/usr/bin/node",
      args: ["/path/to/bridge.js"],
    } as any,
  })
  assert.ok(
    out.args.some((arg) =>
      arg.includes(`mcp_servers.chat.command="/usr/bin/node"`)
    )
  )
  assert.ok(out.args.some((arg) => arg.includes(`mcp_servers.chat.args=`)))
  assert.deepEqual(out.env, {})
})
