// Phase 3 gate for the builtin-presentation leaf:
//  1. Dependency purity — the leaf and every *.presentation.ts must import ONLY
//     the descriptor type from @synapse/device-protocol, never a runtime builtin
//     (filesystem.ts / commandline.ts / …) or any heavy module. This is what
//     lets the API import the leaf without pulling VFS/terminal/sidecar/semver.
//  2. Key shape — every descriptor key is a presentation stableKey
//     `${exposure_stable_key}/${visible_tool_name}` (e.g. builtin/filesystem/fs_edit),
//     NOT a tool's own stable_key (filesystem/edit).
//  3. fs_edit carries a result summary referencing meta.* fields Phase 2 lands.

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { BUILTIN_PRESENTATION, getBuiltinPresentation } from "./index.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const builtinsDir = path.join(here, "..", "builtins")

test("purity: *.presentation.ts import only the device-protocol descriptor type", () => {
  const files = readdirSync(builtinsDir).filter((f) =>
    f.endsWith(".presentation.ts")
  )
  assert.ok(
    files.length >= 5,
    `expected >=5 presentation files, got ${files.length}`
  )
  const importRe = /import\s+[^;]*?from\s+["']([^"']+)["']/g
  for (const file of files) {
    const src = readFileSync(path.join(builtinsDir, file), "utf8")
    let m: RegExpExecArray | null
    while ((m = importRe.exec(src))) {
      const spec = m[1]
      assert.ok(
        spec.startsWith("@synapse/device-protocol"),
        `${file} imports forbidden module "${spec}" — presentation data files must` +
          ` import only @synapse/device-protocol (no runtime builtins)`
      )
    }
  }
})

test("purity: the leaf index imports only sibling *.presentation files + the type", () => {
  const src = readFileSync(path.join(here, "index.ts"), "utf8")
  const importRe = /import\s+[^;]*?from\s+["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = importRe.exec(src))) {
    const spec = m[1]
    const ok =
      spec.startsWith("@synapse/device-protocol") ||
      spec.includes(".presentation.js")
    assert.ok(ok, `leaf index imports forbidden module "${spec}"`)
  }
})

test("keys are presentation stableKeys (exposure/visibleName), not tool stable_key", () => {
  const keys = Object.keys(BUILTIN_PRESENTATION)
  assert.ok(keys.length > 0)
  for (const key of keys) {
    assert.ok(
      key.startsWith("builtin/"),
      `key "${key}" should start with the exposure stable key "builtin/…"`
    )
  }
  // fs_edit specifically: exposure builtin/filesystem + visible name fs_edit.
  assert.ok(
    getBuiltinPresentation("builtin/filesystem/fs_edit"),
    "expected builtin/filesystem/fs_edit"
  )
  // NOT the tool's own stable_key.
  assert.equal(getBuiltinPresentation("filesystem/edit"), undefined)
})

test("fs_edit descriptor: diff request + result summary referencing meta.*", () => {
  const d = getBuiltinPresentation("builtin/filesystem/fs_edit")
  assert.ok(d)
  assert.equal(d!.request.mode, "diff")
  assert.equal(d!.request.diff?.itemsPath, "edits")
  const summaryArgs = d!.result?.summary?.args ?? {}
  assert.equal(summaryArgs.bytes?.path, "meta.bytes_written")
  assert.equal(summaryArgs.applied?.path, "meta.edits_applied")
})

test("coverage: all five builtin families present", () => {
  const families = ["filesystem", "commandline", "browser", "cua"]
  for (const fam of families) {
    assert.ok(
      Object.keys(BUILTIN_PRESENTATION).some((k) =>
        k.startsWith(`builtin/${fam}/`)
      ),
      `missing presentation for builtin/${fam}/*`
    )
  }
  // chrome tools live under builtin/browser/<exposure>/<tool>
  assert.ok(
    Object.keys(BUILTIN_PRESENTATION).some((k) =>
      k.startsWith("builtin/browser/navigation/")
    ),
    "missing chrome navigation presentation"
  )
})
