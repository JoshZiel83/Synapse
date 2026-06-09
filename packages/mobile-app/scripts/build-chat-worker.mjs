import { build } from "esbuild"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, "..")

const outfile = resolve(packageRoot, "public/chat-service-worker.js")

await build({
  absWorkingDir: packageRoot,
  entryPoints: [resolve(packageRoot, "src/workers/chat-service-worker.ts")],
  outfile,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  charset: "utf8",
  legalComments: "none",
  logLevel: "info",
  sourcemap: false,
  banner: {
    js: "/* eslint-disable */",
  },
  alias: {
    "@shared": "../shared/dist/index.js",
    "@shared/chat-queue": "../shared/dist/chat-queue/index.js",
    "@shared/chat-state": "../shared/dist/chat-state/index.js",
    "@shared/datetime": "../shared/dist/datetime/index.js",
    "@shared/uuid": "../shared/dist/uuid/index.js",
  },
})

// Normalize esbuild's module path comments so the committed bundle is
// deterministic regardless of how node_modules is laid out. mobile-app is NOT a
// root workspace, so a standalone `npm install` here nests deps in
// packages/mobile-app/node_modules and esbuild emits `// node_modules/idb/...`;
// in a hoisted checkout the same dep resolves to `// ../../node_modules/idb/...`.
// That difference is pure noise (the bundle bytes are otherwise identical) but
// it makes the sw-constants-shared "no diff vs committed" guard flip per
// environment. Collapse any leading `../` segments before `node_modules/` to a
// bare `node_modules/` so the artifact only reflects SOURCE changes.
normalizeNodeModulesPathComments(outfile)

function normalizeNodeModulesPathComments(file) {
  const original = readFileSync(file, "utf8")
  const normalized = original.replace(
    /\/\/ (?:\.\.\/)+node_modules\//g,
    "// node_modules/"
  )
  if (normalized !== original) {
    writeFileSync(file, normalized)
  }
}
