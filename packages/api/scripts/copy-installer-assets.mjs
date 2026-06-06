#!/usr/bin/env node
// Copy installer assets (install.sh / install.ps1) from src/ to dist/ after the
// TypeScript build. `tsc` only emits .ts -> .js, so these non-TS assets would
// otherwise never reach dist/. Node-based (not `cp`) so it works on Windows
// dev machines too. Mirrors the schema.sql / mcp-plugins asset handling.
//
// Wired as packages/api "postbuild". The runtime also has a src/ fallback (see
// install-command.ts readAsset), so dev `tsx`/uncopied trees still work; this
// makes a built `node dist/index.js` self-contained.

import { copyFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(__dirname, "..")
const srcAssets = join(pkgRoot, "src", "modules", "installer", "assets")
const distAssets = join(pkgRoot, "dist", "modules", "installer", "assets")

const files = ["install.sh", "install.ps1"]

if (!existsSync(join(pkgRoot, "dist"))) {
  // No build output yet — nothing to copy into. Not an error for `tsx` dev.
  console.error("[copy-installer-assets] dist/ absent; skipping (dev mode)")
  process.exit(0)
}

mkdirSync(distAssets, { recursive: true })
for (const f of files) {
  copyFileSync(join(srcAssets, f), join(distAssets, f))
}
console.error(`[copy-installer-assets] copied ${files.join(", ")} -> dist/`)
