import assert from "node:assert/strict"
import { test } from "node:test"
import {
  parseRemoteInstanceCommand,
  parseRuntimeLeaseMetadata,
} from "./instance-manager.js"

const baseParams = {
  pluginId: "plugin-1",
  installationId: "installation-1",
  pluginSlug: "demo-plugin",
  orgSlug: "demo-org",
  transport: "builtin",
  entryPoint: "demo/entrypoint",
  scope: "turn",
  scopeId: "turn-1",
  config: { feature: true },
}

test("parseRemoteInstanceCommand accepts execute command payloads", () => {
  const command = parseRemoteInstanceCommand({
    command: "execute",
    params: baseParams,
    key: "instance-key",
    configHash: "hash-1",
    toolName: "demo.tool",
    input: { query: "hello" },
    executionContext: { requestId: "request-1" },
  })

  assert.equal(command.command, "execute")
  assert.equal(command.params.pluginId, "plugin-1")
  assert.deepEqual(command.input, { query: "hello" })
})

test("parseRemoteInstanceCommand accepts describe command payloads", () => {
  const command = parseRemoteInstanceCommand({
    command: "describe",
    params: baseParams,
    key: "instance-key",
    configHash: "hash-1",
  })

  assert.equal(command.command, "describe")
  assert.equal(command.key, "instance-key")
})

test("parseRemoteInstanceCommand rejects invalid command payloads", () => {
  assert.throws(
    () =>
      parseRemoteInstanceCommand({
        command: "execute",
        params: baseParams,
        key: "instance-key",
        configHash: "hash-1",
        input: {},
      }),
    /Invalid input/
  )

  assert.throws(
    () =>
      parseRemoteInstanceCommand({
        command: "unknown",
        params: baseParams,
        key: "instance-key",
        configHash: "hash-1",
      }),
    /Invalid input/
  )
})

test("parseRuntimeLeaseMetadata validates persisted redis lease metadata", () => {
  assert.deepEqual(
    parseRuntimeLeaseMetadata(
      JSON.stringify({
        nodeId: "node-1",
        token: "token-1",
        instanceKey: "instance-key",
        updatedAt: 123,
      })
    ),
    {
      nodeId: "node-1",
      token: "token-1",
      instanceKey: "instance-key",
      updatedAt: 123,
    }
  )

  assert.equal(parseRuntimeLeaseMetadata("{"), null)
  assert.equal(
    parseRuntimeLeaseMetadata(
      JSON.stringify({
        token: "token-1",
        instanceKey: "instance-key",
        updatedAt: 123,
      })
    ),
    null
  )
})
