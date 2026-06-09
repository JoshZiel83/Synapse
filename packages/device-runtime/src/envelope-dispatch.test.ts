// End-to-end envelope + runtime authorization smoke test. Signs an envelope
// server-side, ships it through the in-memory MCP host with the matching
// trusted server key, and asserts the runtime accepts authorized commands
// and rejects unauthorized ones.

import test from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import {
  signOperationEnvelope,
  type OperationEnvelope,
} from "@synapse/device-protocol"

import { createInMemoryMcpHost } from "./mcp-host.js"
import { createInMemoryEnvelopeVerifier, hashArguments } from "./envelope.js"
import { createCommandlineBuiltin } from "./builtins/commandline.js"

function buildSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const pubPem = publicKey.export({ format: "pem", type: "spki" }) as string
  const privPem = privateKey.export({
    format: "pem",
    type: "pkcs8",
  }) as string
  const kid = "test-kid-" + randomUUID().slice(0, 8)
  return { pubPem, privPem, kid }
}

function makeEnvelope(
  signer: ReturnType<typeof buildSigner>,
  args: Record<string, unknown>,
  grantSpecs: OperationEnvelope["runtime_authorization"] extends infer R
    ? R extends { grant_specs: infer G }
      ? G
      : never
    : never,
  overrides?: Partial<{
    device_capability_id: string
    device_exposure_id: string
    device_tool_id: string
    device_tool_revision_id: string
  }>
): OperationEnvelope {
  return signOperationEnvelope(
    {
      operation_id: randomUUID(),
      attempt_id: randomUUID(),
      device_runtime_session_id: randomUUID(),
      device_capability_id: overrides?.device_capability_id ?? randomUUID(),
      device_exposure_id: overrides?.device_exposure_id ?? randomUUID(),
      device_tool_id: overrides?.device_tool_id ?? randomUUID(),
      device_tool_revision_id:
        overrides?.device_tool_revision_id ?? randomUUID(),
      input_hash: hashArguments(args),
      task_mode: "sync",
      runtime_authorization: {
        grant_ids: ["test-grant"],
        grant_scope: "actor",
        grant_specs: grantSpecs,
      },
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature_kid: signer.kid,
    },
    signer.privPem
  )
}

/**
 * Seed the host's toolTargetIndex with IDs that point at the bash builtin
 * under the same exposure_stable_key the commandline builtin advertises.
 * Without this, the fail-closed dispatch gate (WW1) rejects every envelope
 * because the host has no proof the envelope targets a tool that lives on
 * THIS device.
 */
function seedBashCatalogTargetIds(
  host: ReturnType<typeof createInMemoryMcpHost>,
  envelope: OperationEnvelope
) {
  host.setCatalogTargetIds({
    "builtin/commandline": {
      device_exposure_id: envelope.device_exposure_id,
      tools: {
        bash: {
          device_tool_id: envelope.device_tool_id,
          device_tool_revision_id: envelope.device_tool_revision_id,
        },
      },
    },
  })
}

async function callBash(
  host: ReturnType<typeof createInMemoryMcpHost>,
  envelope: OperationEnvelope | undefined,
  args: Record<string, unknown>
) {
  return callBashWithMeta(
    host,
    envelope ? { synapse_operation: envelope } : undefined,
    args
  )
}

async function callBashWithMeta(
  host: ReturnType<typeof createInMemoryMcpHost>,
  meta: Record<string, unknown> | undefined,
  args: Record<string, unknown>
) {
  const base = `http://127.0.0.1:${host.localPort}`
  const params: Record<string, unknown> = {
    name: "bash",
    arguments: args,
  }
  if (meta) params._meta = meta
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "tools/call",
      params,
    }),
  })
  return (await res.json()) as {
    result?: {
      content?: { type: string; text: string }[]
      isError?: boolean
      _meta?: Record<string, unknown>
    }
  }
}

test("verified envelope with matching commandline grant runs bash", async () => {
  const signer = buildSigner()
  const trustedKeys = new Map([[signer.kid, signer.pubPem]])
  const host = createInMemoryMcpHost({
    envelopeVerifier: createInMemoryEnvelopeVerifier(),
    serverPublicKeys: trustedKeys,
  })
  await host.start()
  try {
    await host.registerCatalog(createCommandlineBuiltin())
    const args = { command: 'printf "hi"' }
    const envelope = makeEnvelope(signer, args, [
      {
        capability: "commandline",
        commandline: {
          executor: "bash",
          command_match_type: "prefix",
          command_text: "printf",
        },
      },
    ])
    seedBashCatalogTargetIds(host, envelope)
    const res = await callBash(host, envelope, args)
    assert.equal(res.result?.isError, false)
    assert.match(res.result?.content?.[0]?.text ?? "", /hi/)
  } finally {
    await host.stop()
  }
})

test("missing envelope is rejected with permission_denied", async () => {
  const signer = buildSigner()
  const host = createInMemoryMcpHost({
    envelopeVerifier: createInMemoryEnvelopeVerifier(),
    serverPublicKeys: new Map([[signer.kid, signer.pubPem]]),
  })
  await host.start()
  try {
    await host.registerCatalog(createCommandlineBuiltin())
    const res = await callBash(host, undefined, { command: "ls" })
    assert.equal(res.result?.isError, true)
    const synapseError = res.result?._meta?.["synapse_error"] as
      | { code: string }
      | undefined
    assert.equal(synapseError?.code, "permission_denied")
  } finally {
    await host.stop()
  }
})

test("malformed envelope is rejected with invalid_request", async () => {
  const signer = buildSigner()
  const host = createInMemoryMcpHost({
    envelopeVerifier: createInMemoryEnvelopeVerifier(),
    serverPublicKeys: new Map([[signer.kid, signer.pubPem]]),
  })
  await host.start()
  try {
    await host.registerCatalog(createCommandlineBuiltin())
    const res = await callBashWithMeta(
      host,
      {
        synapse_operation: {
          operation_id: "not-a-uuid",
        },
      },
      { command: "ls" }
    )
    assert.equal(res.result?.isError, true)
    const synapseError = res.result?._meta?.["synapse_error"] as
      | { code: string; message: string }
      | undefined
    assert.equal(synapseError?.code, "invalid_request")
    assert.match(synapseError?.message ?? "", /schema validation/)
  } finally {
    await host.stop()
  }
})

test("envelope with no commandline grant is rejected", async () => {
  const signer = buildSigner()
  const host = createInMemoryMcpHost({
    envelopeVerifier: createInMemoryEnvelopeVerifier(),
    serverPublicKeys: new Map([[signer.kid, signer.pubPem]]),
  })
  await host.start()
  try {
    await host.registerCatalog(createCommandlineBuiltin())
    const args = { command: "rm -rf /" }
    const envelope = makeEnvelope(signer, args, [
      {
        // a cua grant doesn't cover bash
        capability: "cua",
        cua: { access: "write" },
      },
    ])
    seedBashCatalogTargetIds(host, envelope)
    const res = await callBash(host, envelope, args)
    assert.equal(res.result?.isError, true)
    const synapseError = res.result?._meta?.["synapse_error"] as
      | { code: string; message: string }
      | undefined
    assert.equal(synapseError?.code, "permission_denied")
    assert.match(synapseError?.message ?? "", /commandline/)
  } finally {
    await host.stop()
  }
})

test("envelope dispatch is rejected when catalog target index is empty (fail-closed)", async () => {
  const signer = buildSigner()
  const host = createInMemoryMcpHost({
    envelopeVerifier: createInMemoryEnvelopeVerifier(),
    serverPublicKeys: new Map([[signer.kid, signer.pubPem]]),
  })
  await host.start()
  try {
    await host.registerCatalog(createCommandlineBuiltin())
    const args = { command: "ls" }
    const envelope = makeEnvelope(signer, args, [
      {
        capability: "commandline",
        commandline: {
          executor: "bash",
          command_match_type: "tool",
          command_text: "ls",
        },
      },
    ])
    // Deliberately do NOT call setCatalogTargetIds — this exercises the
    // window between WSS hello and the first device.catalog.sync ack.
    const res = await callBash(host, envelope, args)
    assert.equal(res.result?.isError, true)
    const synapseError = res.result?._meta?.["synapse_error"] as
      | { code: string; message: string }
      | undefined
    assert.equal(synapseError?.code, "permission_denied")
    assert.match(synapseError?.message ?? "", /not yet synced/)
  } finally {
    await host.stop()
  }
})

test("envelope with mismatched device_tool_id is rejected even when name matches", async () => {
  const signer = buildSigner()
  const host = createInMemoryMcpHost({
    envelopeVerifier: createInMemoryEnvelopeVerifier(),
    serverPublicKeys: new Map([[signer.kid, signer.pubPem]]),
  })
  await host.start()
  try {
    await host.registerCatalog(createCommandlineBuiltin())
    const args = { command: "ls" }
    const envelope = makeEnvelope(signer, args, [
      {
        capability: "commandline",
        commandline: {
          executor: "bash",
          command_match_type: "tool",
          command_text: "ls",
        },
      },
    ])
    // Seed the target index with a DIFFERENT device_tool_id than the
    // envelope carries — this simulates a forged/misrouted envelope
    // targeting a tool that doesn't live on this device.
    host.setCatalogTargetIds({
      "builtin/commandline": {
        device_exposure_id: randomUUID(),
        tools: {
          bash: {
            device_tool_id: randomUUID(),
            device_tool_revision_id: randomUUID(),
          },
        },
      },
    })
    const res = await callBash(host, envelope, args)
    assert.equal(res.result?.isError, true)
    const synapseError = res.result?._meta?.["synapse_error"] as
      | { code: string; message: string }
      | undefined
    assert.equal(synapseError?.code, "permission_denied")
    assert.match(
      synapseError?.message ?? "",
      /not in this device's synced catalog/
    )
  } finally {
    await host.stop()
  }
})

test("envelope signed by an untrusted key is rejected", async () => {
  const trusted = buildSigner()
  const untrusted = buildSigner()
  const host = createInMemoryMcpHost({
    envelopeVerifier: createInMemoryEnvelopeVerifier(),
    serverPublicKeys: new Map([[trusted.kid, trusted.pubPem]]),
  })
  await host.start()
  try {
    await host.registerCatalog(createCommandlineBuiltin())
    const args = { command: "ls" }
    const envelope = makeEnvelope(untrusted, args, [
      {
        capability: "commandline",
        commandline: {
          executor: "bash",
          command_match_type: "tool",
          command_text: "ls",
        },
      },
    ])
    const res = await callBash(host, envelope, args)
    assert.equal(res.result?.isError, true)
    const synapseError = res.result?._meta?.["synapse_error"] as
      | { code: string }
      | undefined
    assert.equal(synapseError?.code, "invalid_request")
  } finally {
    await host.stop()
  }
})

test("expired envelope is rejected with expired_envelope", async () => {
  const signer = buildSigner()
  const host = createInMemoryMcpHost({
    envelopeVerifier: createInMemoryEnvelopeVerifier(),
    serverPublicKeys: new Map([[signer.kid, signer.pubPem]]),
  })
  await host.start()
  try {
    await host.registerCatalog(createCommandlineBuiltin())
    const args = { command: "ls" }
    const envelope = signOperationEnvelope(
      {
        operation_id: randomUUID(),
        attempt_id: randomUUID(),
        device_runtime_session_id: randomUUID(),
        device_capability_id: randomUUID(),
        device_exposure_id: randomUUID(),
        device_tool_id: randomUUID(),
        device_tool_revision_id: randomUUID(),
        input_hash: hashArguments(args),
        task_mode: "sync",
        runtime_authorization: {
          grant_ids: ["g"],
          grant_scope: "actor",
          grant_specs: [
            {
              capability: "commandline",
              commandline: {
                executor: "bash",
                command_match_type: "tool",
                command_text: "ls",
              },
            },
          ],
        },
        issued_at: new Date(Date.now() - 120_000).toISOString(),
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        signature_kid: signer.kid,
      },
      signer.privPem
    )
    const res = await callBash(host, envelope, args)
    assert.equal(res.result?.isError, true)
    const synapseError = res.result?._meta?.["synapse_error"] as
      | { code: string }
      | undefined
    assert.equal(synapseError?.code, "expired_envelope")
  } finally {
    await host.stop()
  }
})
