import { build } from "esbuild"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, "..")

const outfile = resolve(packageRoot, "public/web-chat-service-worker.js")

await build({
  absWorkingDir: packageRoot,
  entryPoints: [resolve(packageRoot, "lib/workers/web-chat-service-worker.ts")],
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
})

// Normalize esbuild's module path comments so the committed bundle is
// deterministic regardless of node_modules layout (collapse leading `../`
// segments before `node_modules/`). Kept in lockstep with mobile-app's
// build-chat-worker.mjs so both SW bundles use the same canonical form and the
// sw-constants-shared "no diff vs committed" guard only trips on SOURCE drift.
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
