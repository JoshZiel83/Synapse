import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const schemasDir = dirname(fileURLToPath(import.meta.url))

const classifiedOpenShapeFiles = {
  "automation.ts":
    "Automation matcher, schedule, policy, and delivery payloads carry extensible rule config.",
  "chat-content-block.ts":
    "Mention metadata is an open transport/presentation record.",
  "chat.ts":
    "Chat metadata, draft payloads, and app input metadata are explicit open records.",
  "devices.ts":
    "Device metadata and context are extensible device/app records.",
  "events.ts": "Internal event-bus payload is an open object envelope.",
  "files.ts":
    "Origin details and structured parser output are presentation/open object records.",
  "im.ts": "IM connector records carry provider-owned metadata/config.",
  "mcp-plugins.ts":
    "Plugin config schemas, defaults, literals, manifests, and metadata are provider/plugin-owned passthrough.",
  "memory.ts": "Memory metadata remains an app-owned open object record.",
  "model-groups.ts":
    "Provider options and attempt policies are provider/config open records.",
  "organization.ts":
    "Actor config/source plus version diff before/after values are intentionally opaque.",
  "remote-agents.ts":
    "Remote-agent runtime/config metadata is an explicit open object record.",
  "runtime-authorizations.ts":
    "Runtime source request args are machine/tool invocation context.",
  "skills.ts":
    "Skill hooks, locators, and metadata are marketplace/import adapter records.",
  "workspace-resources.ts":
    "Workspace resource config and metadata are app/plugin-owned open records.",
} as const

function schemaSources(): Array<{ file: string; source: string }> {
  return readdirSync(schemasDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
    )
    .map((entry) => ({
      file: entry.name,
      source: stripComments(readFileSync(join(schemasDir, entry.name), "utf8")),
    }))
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
}

test("shared schema files do not use z.any()", () => {
  const offenders = schemaSources()
    .filter(({ source }) => /\bz\s*\.\s*any\s*\(/.test(source))
    .map(({ file }) => file)
    .sort()

  assert.deepEqual(offenders, [])
})

test("shared schema open shapes stay on the classified finite list", () => {
  const filesWithOpenShapes = schemaSources()
    .filter(({ source }) => /\bz\s*\.\s*unknown\s*\(/.test(source))
    .map(({ file }) => file)
    .sort()
  const classifiedFiles = Object.keys(classifiedOpenShapeFiles).sort()

  assert.deepEqual(filesWithOpenShapes, classifiedFiles)
  assert.deepEqual(
    Object.entries(classifiedOpenShapeFiles).filter(
      ([, reason]) => reason.trim().length === 0
    ),
    []
  )
})
