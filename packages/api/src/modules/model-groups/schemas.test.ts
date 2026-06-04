import test from "node:test"
import assert from "node:assert/strict"
import { modelGroupsFileSchema, modelGroupsResolvedSchema } from "./schemas.js"

// A minimal valid RAW item (apiKey as a ${VAR} reference, as required pre-interp).
function rawItem(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "Claude Sonnet",
    providerType: "anthropic",
    engineKind: "anthropic.messages",
    apiKey: "${ANTHROPIC_API_KEY}",
    baseUrl: "https://api.anthropic.com",
    modelName: "claude-sonnet-4-20250514",
    maxTokens: 4096,
    ...overrides,
  }
}

function rawDoc(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    groups: [
      {
        name: "Platform Default",
        routingStrategy: "priority_failover",
        isDefault: true,
        items: [rawItem()],
        ...overrides,
      },
    ],
  }
}

test("accepts a well-formed raw document", () => {
  assert.equal(modelGroupsFileSchema.safeParse(rawDoc()).success, true)
})

test("rejects version other than 1", () => {
  const doc = { ...rawDoc(), version: 2 }
  assert.equal(modelGroupsFileSchema.safeParse(doc).success, false)
})

test("rejects a plaintext apiKey in the raw document (must be ${VAR})", () => {
  const doc = {
    version: 1,
    groups: [
      { name: "G", items: [rawItem({ apiKey: "sk-plaintext-secret" })] },
    ],
  }
  assert.equal(modelGroupsFileSchema.safeParse(doc).success, false)
})

test("rejects unknown keys (strict) — e.g. a non-platform ownerType", () => {
  const doc = {
    version: 1,
    groups: [{ name: "G", ownerType: "workspace", items: [rawItem()] }],
  }
  const result = modelGroupsFileSchema.safeParse(doc)
  assert.equal(result.success, false)
})

test("rejects an unknown key on an item (strict)", () => {
  const doc = {
    version: 1,
    groups: [{ name: "G", items: [rawItem({ bogusField: true })] }],
  }
  assert.equal(modelGroupsFileSchema.safeParse(doc).success, false)
})

test("rejects more than one isDefault: true group", () => {
  const doc = {
    version: 1,
    groups: [
      { name: "A", isDefault: true, items: [rawItem()] },
      { name: "B", isDefault: true, items: [rawItem()] },
    ],
  }
  assert.equal(modelGroupsFileSchema.safeParse(doc).success, false)
})

test("rejects duplicate group names within the file", () => {
  const doc = {
    version: 1,
    groups: [
      { name: "Dup", items: [rawItem()] },
      { name: "Dup", items: [rawItem()] },
    ],
  }
  assert.equal(modelGroupsFileSchema.safeParse(doc).success, false)
})

test("rejects duplicate item displayNames within a group", () => {
  const doc = {
    version: 1,
    groups: [
      {
        name: "G",
        items: [
          rawItem({ displayName: "Same" }),
          rawItem({ displayName: "Same" }),
        ],
      },
    ],
  }
  assert.equal(modelGroupsFileSchema.safeParse(doc).success, false)
})

test("rejects an empty items array (min 1)", () => {
  const doc = { version: 1, groups: [{ name: "G", items: [] }] }
  assert.equal(modelGroupsFileSchema.safeParse(doc).success, false)
})

test("rejects an empty groups array (min 1)", () => {
  const doc = { version: 1, groups: [] }
  assert.equal(modelGroupsFileSchema.safeParse(doc).success, false)
})

test("rejects an unknown provider type", () => {
  const doc = {
    version: 1,
    groups: [{ name: "G", items: [rawItem({ providerType: "bogus" })] }],
  }
  assert.equal(modelGroupsFileSchema.safeParse(doc).success, false)
})

test("accepts a valid attemptPolicy on a group", () => {
  const doc = {
    version: 1,
    groups: [
      {
        name: "G",
        attemptPolicy: { maxAttemptsTotal: 3, continueOn: ["timeout"] },
        items: [rawItem()],
      },
    ],
  }
  assert.equal(modelGroupsFileSchema.safeParse(doc).success, true)
})

test("rejects a typo'd attemptPolicy key (strict, not silently kept)", () => {
  const doc = {
    version: 1,
    groups: [
      {
        name: "G",
        // "continuOn" is a typo for "continueOn" — must fail loud, not be dropped.
        attemptPolicy: { continuOn: ["timeout"] },
        items: [rawItem()],
      },
    ],
  }
  assert.equal(modelGroupsFileSchema.safeParse(doc).success, false)
})

// ---- resolved schema (post-interpolation) ----

function resolvedItem(overrides: Record<string, unknown> = {}) {
  return rawItem({ apiKey: "sk-real-secret", ...overrides })
}

test("resolved schema accepts a real (non-${VAR}) apiKey", () => {
  const doc = {
    version: 1,
    groups: [{ name: "G", items: [resolvedItem()] }],
  }
  assert.equal(modelGroupsResolvedSchema.safeParse(doc).success, true)
})

test("resolved schema rejects an empty apiKey (an ${ENV} that resolved to '')", () => {
  const doc = {
    version: 1,
    groups: [{ name: "G", items: [resolvedItem({ apiKey: "" })] }],
  }
  assert.equal(modelGroupsResolvedSchema.safeParse(doc).success, false)
})

test("resolved schema still enforces uniqueness after interpolation", () => {
  // Simulates two ${VAR}s collapsing to the same group name post-interpolation.
  const doc = {
    version: 1,
    groups: [
      { name: "Collapsed", items: [resolvedItem()] },
      { name: "Collapsed", items: [resolvedItem()] },
    ],
  }
  assert.equal(modelGroupsResolvedSchema.safeParse(doc).success, false)
})
