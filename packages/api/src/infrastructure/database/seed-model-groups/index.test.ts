import test from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import {
  loadModelGroupsConfig,
  resolveModelGroupsConfigPath,
  ModelGroupsConfigError,
} from "./index.js"

// These tests cover the READ-ONLY load pipeline of the importer:
//   path resolution -> read -> YAML -> raw schema -> ${ENV} interpolation ->
//   resolved schema -> semantic validation (provider/engine/maxTokens).
// They are DB-free: loadModelGroupsConfig performs no DB I/O, and the pg pool
// is lazy (no connection until a query runs). The DB-backed write half
// (applyModelGroups) is exercised by the integration suite, not here.

const DIR = mkdtempSync(join(tmpdir(), "mg-load-test-"))
let counter = 0
function writeConfig(text: string): string {
  const p = join(DIR, `cfg-${counter++}.yaml`)
  writeFileSync(p, text)
  return p
}

// A valid single-group config; apiKey is a ${VAR} reference as the raw schema requires.
const VALID = `
version: 1
groups:
  - name: Platform Default
    routingStrategy: priority_failover
    isDefault: true
    items:
      - displayName: Claude Sonnet
        providerType: anthropic
        engineKind: anthropic.messages
        apiKey: \${MG_TEST_KEY}
        baseUrl: https://api.anthropic.com
        modelName: claude-sonnet-4-20250514
        maxTokens: 4096
`

test.after(() => rmSync(DIR, { recursive: true, force: true }))

// ---- resolveModelGroupsConfigPath ----

test("resolveModelGroupsConfigPath: absolute override is used as-is", () => {
  const abs = "/tmp/some/abs/model-groups.yaml"
  assert.equal(resolveModelGroupsConfigPath(abs), abs)
})

test("resolveModelGroupsConfigPath: relative override resolves under repo root (not cwd)", () => {
  const resolved = resolveModelGroupsConfigPath("packages/api/config/x.yaml")
  assert.ok(isAbsolute(resolved))
  assert.ok(resolved.endsWith("/packages/api/config/x.yaml"))
})

test("resolveModelGroupsConfigPath: empty/undefined falls back to repo default", () => {
  const def = resolveModelGroupsConfigPath()
  assert.ok(def.endsWith("/packages/api/config/model-groups.yaml"))
  assert.equal(resolveModelGroupsConfigPath(""), def)
})

// ---- loadModelGroupsConfig: happy path + interpolation ----

test("loads a valid config and interpolates ${ENV} api keys", async () => {
  process.env.MG_TEST_KEY = "sk-test-secret"
  const { doc } = await loadModelGroupsConfig({
    configPath: writeConfig(VALID),
    onMissingFile: "throw",
  })
  assert.ok(doc)
  assert.equal(doc.groups[0].items[0].apiKey, "sk-test-secret")
})

// ---- missing file behavior ----

test("missing file with onMissingFile=skip returns doc:null (no throw)", async () => {
  const { doc } = await loadModelGroupsConfig({
    configPath: join(DIR, "does-not-exist.yaml"),
    onMissingFile: "skip",
  })
  assert.equal(doc, null)
})

test("missing file with onMissingFile=throw fails loud", async () => {
  await assert.rejects(
    loadModelGroupsConfig({
      configPath: join(DIR, "does-not-exist.yaml"),
      onMissingFile: "throw",
    }),
    (e) => e instanceof ModelGroupsConfigError && /not found/i.test(e.message)
  )
})

// ---- malformed input ----

test("invalid YAML fails loud", async () => {
  const p = writeConfig("version: 1\ngroups: [ : : : ]")
  await assert.rejects(
    loadModelGroupsConfig({ configPath: p, onMissingFile: "throw" }),
    (e) => e instanceof ModelGroupsConfigError
  )
})

test("a non-mapping YAML root (list) fails loud", async () => {
  const p = writeConfig("- a\n- b\n")
  await assert.rejects(
    loadModelGroupsConfig({ configPath: p, onMissingFile: "throw" }),
    (e) => e instanceof ModelGroupsConfigError && /mapping/i.test(e.message)
  )
})

// ---- raw-schema: plaintext secret rejected before interpolation ----

test("a plaintext apiKey (not ${VAR}) fails loud at the raw schema", async () => {
  process.env.MG_TEST_KEY = "sk-test-secret"
  const p = writeConfig(VALID.replace("${MG_TEST_KEY}", "sk-plaintext-literal"))
  await assert.rejects(
    loadModelGroupsConfig({ configPath: p, onMissingFile: "throw" }),
    (e) => e instanceof ModelGroupsConfigError && /apiKey/.test(e.message)
  )
})

// ---- missing env var aggregation ----

test("an unset ${ENV} reference fails loud and names the variable", async () => {
  delete process.env.MG_TEST_KEY
  await assert.rejects(
    loadModelGroupsConfig({
      configPath: writeConfig(VALID),
      onMissingFile: "throw",
    }),
    (e) => e instanceof ModelGroupsConfigError && /MG_TEST_KEY/.test(e.message)
  )
})

// ---- semantic validation (provider/engine/maxTokens) ----

test("provider/engine mismatch fails loud (semantic preflight)", async () => {
  process.env.MG_TEST_KEY = "sk-test-secret"
  const cfg = `
version: 1
groups:
  - name: G
    items:
      - displayName: X
        providerType: anthropic
        engineKind: openai.chat_completions
        apiKey: \${MG_TEST_KEY}
        baseUrl: https://api.anthropic.com
        modelName: claude-sonnet-4-20250514
`
  await assert.rejects(
    loadModelGroupsConfig({
      configPath: writeConfig(cfg),
      onMissingFile: "throw",
    }),
    (e) =>
      e instanceof ModelGroupsConfigError &&
      /engine .* not valid|Unknown engine/i.test(e.message)
  )
})

test("maxTokens over the provider ceiling fails loud (semantic preflight)", async () => {
  process.env.MG_TEST_KEY = "sk-test-secret"
  const cfg = `
version: 1
groups:
  - name: G
    items:
      - displayName: GLM
        providerType: bigmodel
        engineKind: bigmodel.chat_completions
        apiKey: \${MG_TEST_KEY}
        baseUrl: https://open.bigmodel.cn/api
        modelName: glm-4.6
        maxTokens: 999999999
`
  await assert.rejects(
    loadModelGroupsConfig({
      configPath: writeConfig(cfg),
      onMissingFile: "throw",
    }),
    (e) => e instanceof ModelGroupsConfigError && /max tokens/i.test(e.message)
  )
})

// ---- the shipped example template must pass the full pipeline ----

test("the committed model-groups.yaml.example validates end-to-end", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-example"
  const { doc } = await loadModelGroupsConfig({
    configPath: "packages/api/config/model-groups.yaml.example",
    onMissingFile: "throw",
  })
  assert.ok(doc)
  assert.equal(doc.groups[0].items[0].apiKey, "sk-example")
})
