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
    params: {
      ...baseParams,
      idleTtlMs: 60_000,
      maxAgeMs: 120_000,
    },
    key: "instance-key",
    configHash: "hash-1",
    toolName: "demo.tool",
    input: { query: "hello" },
    executionContext: { requestId: "request-1" },
  })

  assert.equal(command.command, "execute")
  assert.equal(command.params.pluginId, "plugin-1")
  assert.equal(command.params.idleTtlMs, 60_000)
  assert.equal(command.params.maxAgeMs, 120_000)
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

test("parseRemoteInstanceCommand rejects drifted TTL parameters", () => {
  for (const { params, field } of [
    { params: { ...baseParams, idleTtlMs: 0 }, field: "idleTtlMs" },
    { params: { ...baseParams, idleTtlMs: -1 }, field: "idleTtlMs" },
    { params: { ...baseParams, idleTtlMs: 1.5 }, field: "idleTtlMs" },
    { params: { ...baseParams, maxAgeMs: 0 }, field: "maxAgeMs" },
    { params: { ...baseParams, maxAgeMs: -1 }, field: "maxAgeMs" },
    { params: { ...baseParams, maxAgeMs: 1.5 }, field: "maxAgeMs" },
  ]) {
    assert.throws(
      () =>
        parseRemoteInstanceCommand({
          command: "describe",
          params,
          key: "instance-key",
          configHash: "hash-1",
        }),
      (error) => error instanceof Error && error.message.includes(field)
    )
  }
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

  for (const metadata of [
    [],
    null,
    {
      nodeId: "node-1",
      token: "token-1",
      instanceKey: "instance-key",
      updatedAt: -1,
    },
    {
      nodeId: "node-1",
      token: "token-1",
      instanceKey: "instance-key",
      updatedAt: 1.5,
    },
    {
      nodeId: "node-1",
      token: "token-1",
      instanceKey: "instance-key",
      updatedAt: 123,
      extra: true,
    },
  ]) {
    assert.equal(parseRuntimeLeaseMetadata(JSON.stringify(metadata)), null)
  }
})
