#!/usr/bin/env node
// Prepare self-hosted emoji assets so the design sandbox renders emoji WITHOUT
// any external (jsDelivr) requests at runtime:
//   • Twemoji v14.0.2 SVGs  → public/twemoji/svg/   (rendered emoji, see lib/twemoji.ts)
//   • emojibase en data     → public/emojibase/en/  (Frimousse picker, see ui/emoji-picker.tsx)
// public/twemoji/ and public/emojibase/ are git-ignored; run this once after
// checkout (wired into `predev`). Idempotent.
import { execSync } from "node:child_process"
import { createRequire } from "node:module"
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)

// ── Twemoji SVGs ─────────────────────────────────────────────────────────────
const twOut = join(root, "public", "twemoji")
const svgDir = join(twOut, "svg")
const VERSION = "14.0.2" // must match @synapse/shared/emoji TWEMOJI_ASSET_BASE
if (existsSync(svgDir) && readdirSync(svgDir).length > 3000) {
  console.log(`✓ twemoji present (${readdirSync(svgDir).length} svg)`)
} else {
  mkdirSync(twOut, { recursive: true })
  const url = `https://github.com/jdecked/twemoji/archive/refs/tags/v${VERSION}.tar.gz`
  console.log(`Fetching twemoji v${VERSION} svg → public/twemoji/svg/ …`)
  execSync(
    `curl -sL --max-time 300 "${url}" | tar xz -C "${twOut}" --strip-components=2 --wildcards '*/assets/svg/*'`,
    { stdio: "inherit", shell: "/bin/bash" }
  )
  console.log(`✓ twemoji done (${readdirSync(svgDir).length} svg)`)
}

// ── emojibase data (Frimousse picker) ────────────────────────────────────────
// Frimousse fetches {emojibaseUrl}/{locale}/data.json + messages.json. We only
// ship the default 'en' locale; add more locales here if the picker's locale
// prop changes.
const ebOut = join(root, "public", "emojibase", "en")
mkdirSync(ebOut, { recursive: true })
for (const file of ["data.json", "messages.json"]) {
  const src = require.resolve(`emojibase-data/en/${file}`)
  copyFileSync(src, join(ebOut, file))
}
console.log(`✓ emojibase en copied → public/emojibase/en/`)
