#!/usr/bin/env tsx
// Audits the device-runtime sidecar CONTRACT end-to-end — the parts
// specific to the six platform bundles that can drift independently of
// the version numbers. This is the single gate that catches drift on
// any of them:
//
//   1. Per-sidecar manifest hygiene — each sidecar is declared as an
//      optionalDependency of @synapse/device-runtime, is `private: true`
//      (so a direct `npm publish -w <sidecar>` is refused by npm itself),
//      and declares publishConfig.os/cpu matching its platformKey with
//      NO top-level os/cpu (which would trip npm 9 EBADPLATFORM on the
//      dev install). The publish wrapper
//      (scripts/publish-device-runtime-sidecars.sh) hoists os/cpu to
//      top-level when publishing.
//
//   2. Shared ↔ manifest ↔ sidecar archive parity — BUNDLE_ELIGIBLE_
//      PROGRAMS ⊆ BUNDLE_PROGRAM_PLATFORM_KEYS, every PLATFORM_KEYS
//      entry has a real manifest row, every manifest row has a
//      committed sidecar archive matching BOTH content sha256 AND
//      one of the runtime probe filenames (`<sha>.<ext>` or `<sha>`).
//
//   3. Publish-script + helper-binary distribution invariants — the
//      publish wrapper enumerates exactly the committed sidecar dirs, and
//      the Go/Rust helper binaries stay OUT of the npm channel (F9c).
//
// NOT this script's job: version COHESION. The six bundles are DECOUPLED
// from the @synapse release cohort — they pin to their own independent
// version and publish on a separate cadence — so coupling a sidecar's
// version to device-runtime's would be wrong (it would 404 the pin and
// strip every sidecar on install). Cohort lockstep, exact bundle pins
// (optionalDependency == the bundle's OWN version), and package-lock sync
// are all enforced by scripts/guard-workspace-versions.mjs, which IS
// wired into verify-boundary.sh.
//
// Run via `npm run audit:device-runtime-sidecars` from the repo root.
// Exits 1 on any drift with a punch list, 0 when everything lines up.
//
// Loaded via `tsx` so we import directly from
// `packages/shared/src/access/policies/commandline-normalize.ts` —
// no dependency on a freshly built @synapse/shared dist. A clean
// checkout that hasn't run `npm run build` can still run the audit,
// and changes to the source surface immediately without needing a
// rebuild. (The shared source module is zod-free with no other
// runtime deps, so tsx can load it directly.)

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  BUNDLE_ELIGIBLE_PROGRAMS,
  BUNDLE_PROGRAM_PLATFORM_KEYS,
} from "../packages/shared/src/access/policies/commandline-normalize.ts"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const MAIN_PKG = join(REPO_ROOT, "packages", "device-runtime", "package.json")
const MANIFEST = join(
  REPO_ROOT,
  "packages",
  "device-runtime",
  "bundles",
  "manifest.json"
)
// Derive the canonical platformKey set as the UNION of four sources
// of truth — every place a sidecar key can show up. Each loop below
// then iterates this union; a key that's in one source but missing
// from another surfaces as a specific error in the relevant loop
// (e.g. shared+manifest claims a key but no sidecar dir → "missing
// package.json"; sidecar dir exists but no manifest entry → orphan
// error emitted explicitly below).
//
// Sources:
//   (a) BUNDLE_PROGRAM_PLATFORM_KEYS values — what the API gate
//       expects to grant.
//   (b) manifest.json platformKeys — what the device-runtime
//       resolver can extract.
//   (c) @synapse/device-runtime's optionalDependencies — every
//       sidecar npm declares it consumes.
//   (d) Existing packages/device-runtime-bundles-*/ directories —
//       every sidecar workspace that physically exists in the repo.
//
// Earlier shapes derived from a strict subset and missed the reverse-
// drift case the user called out: dropping a platformKey from shared/
// manifest but forgetting to remove the orphan sidecar dep + package
// dir. Pulling all four into the union means orphans get caught.
const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8"))
const main = JSON.parse(readFileSync(MAIN_PKG, "utf-8"))
const optionalDeps = (main.optionalDependencies ?? {}) as Record<string, string>

function extractKeyFromDepName(depName: string): string | null {
  const prefix = "@synapse/device-runtime-bundles-"
  if (!depName.startsWith(prefix)) return null
  const key = depName.slice(prefix.length)
  return key.length > 0 ? key : null
}

const sharedKeys = new Set<string>()
for (const platformKeys of Object.values(BUNDLE_PROGRAM_PLATFORM_KEYS)) {
  for (const k of platformKeys) sharedKeys.add(k)
}
const manifestKeys = new Set<string>()
for (const programEntry of Object.values(
  (manifest.programs ?? {}) as Record<string, { platforms?: Record<string, unknown> }>
)) {
  for (const k of Object.keys(programEntry.platforms ?? {})) manifestKeys.add(k)
}
const depKeys = new Set<string>()
for (const depName of Object.keys(optionalDeps)) {
  const k = extractKeyFromDepName(depName)
  if (k) depKeys.add(k)
}
const dirKeys = new Set<string>()
const PACKAGES_DIR = join(REPO_ROOT, "packages")
if (existsSync(PACKAGES_DIR)) {
  for (const entry of readdirSync(PACKAGES_DIR)) {
    const k = extractKeyFromDirName(entry)
    if (k) dirKeys.add(k)
  }
}
function extractKeyFromDirName(dirName: string): string | null {
  const prefix = "device-runtime-bundles-"
  if (!dirName.startsWith(prefix)) return null
  const key = dirName.slice(prefix.length)
  return key.length > 0 ? key : null
}

const SIDECAR_PLATFORM_KEYS = [
  ...new Set([...sharedKeys, ...manifestKeys, ...depKeys, ...dirKeys]),
].sort()

const errors: string[] = []

// (0) Orphan detection — sidecar shows up in optionalDeps OR as a
// packages dir but neither shared nor manifest claims it. This is
// the reverse-drift case the user called out: dropping a key from
// shared/manifest without also pruning the optionalDep / package
// dir leaves dead bytes shipping forever.
for (const key of SIDECAR_PLATFORM_KEYS) {
  const inSharedOrManifest = sharedKeys.has(key) || manifestKeys.has(key)
  if (inSharedOrManifest) continue
  const orphanSources: string[] = []
  if (depKeys.has(key)) {
    orphanSources.push("@synapse/device-runtime.optionalDependencies")
  }
  if (dirKeys.has(key)) {
    orphanSources.push(`packages/device-runtime-bundles-${key}/`)
  }
  errors.push(
    `orphan sidecar "${key}": present in ${orphanSources.join(" + ")} but NOT in BUNDLE_PROGRAM_PLATFORM_KEYS or manifest.json. Either re-add it to shared+manifest, or remove the optionalDependency entry AND the packages/ directory so the orphan bytes stop shipping.`
  )
}

// (1) per-sidecar manifest hygiene — declared-as-optionalDependency +
// `private: true` + publishConfig os/cpu. Version pinning/cohesion is
// guard-workspace-versions' job (bundles are DECOUPLED from the cohort);
// here the optionalDependency entry is checked only for PRESENCE — a
// sidecar dir that exists but isn't wired into optionalDependencies would
// never install on a consumer.
for (const key of SIDECAR_PLATFORM_KEYS) {
  const pkgName = `@synapse/device-runtime-bundles-${key}`
  if (!optionalDeps[pkgName]) {
    errors.push(
      `${pkgName}: not in @synapse/device-runtime optionalDependencies`
    )
    continue
  }
  const sidecarPkgPath = join(
    REPO_ROOT,
    "packages",
    `device-runtime-bundles-${key}`,
    "package.json"
  )
  if (!existsSync(sidecarPkgPath)) {
    errors.push(`${pkgName}: package.json missing at ${sidecarPkgPath}`)
    continue
  }
  const sidecarPkg = JSON.parse(readFileSync(sidecarPkgPath, "utf-8"))
  // Sidecars MUST be `private: true` in source. This is the npm-enforced
  // block against a direct `npm publish -w <sidecar>` — unlike the
  // prepublishOnly guard (sidecar-publish-guard.mjs), `private: true`
  // cannot be bypassed with `--ignore-scripts`. A direct publish would
  // ship the package WITHOUT top-level os/cpu (those live only under
  // publishConfig until the wrapper hoists them), so every consumer would
  // download all six sidecars. The sanctioned path
  // (scripts/publish-device-runtime-sidecars.sh) strips `private` in its
  // staging jq, so the wrapper can still publish. `private: true` does NOT
  // block the dev-time workspace install (it only blocks publish).
  if (sidecarPkg.private !== true) {
    errors.push(
      `${pkgName}: must set \`"private": true\` so \`npm publish -w <sidecar>\` (even with --ignore-scripts) is refused by npm itself; the publish wrapper strips it in staging. Without it a direct publish ships an unfiltered sidecar (no top-level os/cpu) and consumers download all six.`
    )
  }
  // npm 9 errors EBADPLATFORM on workspace deps with TOP-LEVEL os/cpu
  // mismatched against the dev host, even when listed under
  // optionalDependencies — which blocks the dev `npm install`
  // outright. So sidecars carry os/cpu under publishConfig and the
  // publish wrapper (scripts/publish-device-runtime-sidecars.sh)
  // hoists them at publish time. Audit enforces both:
  //   (a) publishConfig.os / publishConfig.cpu are set per platformKey
  //       and match the expected (os, cpu) for this sidecar; otherwise
  //       the published tarball lands without a registry filter and
  //       consumers download all 6 sidecars per host.
  //   (b) top-level os/cpu is NOT set (would break the dev install).
  const [expectedOs, expectedCpu] = key.split("-", 2)
  const publishOs = sidecarPkg.publishConfig?.os
  const publishCpu = sidecarPkg.publishConfig?.cpu
  if (!Array.isArray(publishOs) || !publishOs.includes(expectedOs)) {
    errors.push(
      `${pkgName}: publishConfig.os must include "${expectedOs}" (got ${JSON.stringify(publishOs)}) so the publish wrapper can hoist it.`
    )
  }
  if (!Array.isArray(publishCpu) || !publishCpu.includes(expectedCpu)) {
    errors.push(
      `${pkgName}: publishConfig.cpu must include "${expectedCpu}" (got ${JSON.stringify(publishCpu)}) so the publish wrapper can hoist it.`
    )
  }
  if (sidecarPkg.os !== undefined) {
    errors.push(
      `${pkgName}: top-level "os" is set ("${JSON.stringify(sidecarPkg.os)}") — would trip npm 9 EBADPLATFORM during dev install. Move to publishConfig.os; the publish wrapper hoists it on publish.`
    )
  }
  if (sidecarPkg.cpu !== undefined) {
    errors.push(
      `${pkgName}: top-level "cpu" is set — would trip npm 9 EBADPLATFORM during dev install. Move to publishConfig.cpu.`
    )
  }
}

// (2) manifest ↔ shared parity. Pulled in from
// @synapse/shared/access/policies/commandline-normalize.ts so the
// audit catches drift between BUNDLE_ELIGIBLE_PROGRAMS,
// BUNDLE_PROGRAM_PLATFORM_KEYS, and manifest.json — the three
// surfaces that together determine whether the API proposes
// `allow_bundled_toolchain: true` and the runtime can satisfy it.
// device-runtime's terminal/manifest.test.ts exercises the same
// parity at test time; running it here ALSO from the audit means a
// pre-commit / CI step that runs `npm run audit:device-runtime-
// sidecars` catches the drift without needing to spin up the test
// suite. (manifest was already loaded above for the SIDECAR_PLATFORM_
// KEYS derivation; reused here.)
for (const program of BUNDLE_ELIGIBLE_PROGRAMS) {
  // (a) every eligible program has at least one platformKey declared.
  const platformKeys = BUNDLE_PROGRAM_PLATFORM_KEYS[program]
  if (!platformKeys || platformKeys.length === 0) {
    errors.push(
      `shared: "${program}" is in BUNDLE_ELIGIBLE_PROGRAMS but has no entry in BUNDLE_PROGRAM_PLATFORM_KEYS. Remove it from eligible or add platformKeys; otherwise the API claims fallback for a program the device can never resolve.`
    )
    continue
  }
  // (b) every claimed platformKey has a real manifest row with a
  //     usable download URL.
  const manifestEntry = manifest.programs?.[program]
  if (!manifestEntry) {
    errors.push(
      `shared/manifest: "${program}" is bundle-eligible but missing from manifest.json. Add the manifest entries or drop the program from BUNDLE_ELIGIBLE_PROGRAMS.`
    )
    continue
  }
  for (const platformKey of platformKeys) {
    const platformEntry = manifestEntry.platforms?.[platformKey]
    if (!platformEntry) {
      errors.push(
        `shared/manifest: "${program}.${platformKey}" claimed by BUNDLE_PROGRAM_PLATFORM_KEYS but missing in manifest.json — the API would propose allow_bundled_toolchain=true but the device resolver has nothing to extract.`
      )
      continue
    }
    const url = platformEntry.download?.url ?? ""
    if (url.length === 0 || url.startsWith("TODO") || url.startsWith("<")) {
      errors.push(
        `shared/manifest: "${program}.${platformKey}" manifest entry has a placeholder download.url ("${url}"). Either publish the asset and update the URL, or drop the platformKey from BUNDLE_PROGRAM_PLATFORM_KEYS.`
      )
    }
  }
}
// (c) reverse direction: every manifest program is bundle-eligible
//     (and every manifest (program, platformKey) is in PLATFORM_KEYS).
for (const [program, programEntry] of Object.entries(manifest.programs ?? {})) {
  if (!BUNDLE_ELIGIBLE_PROGRAMS.includes(program)) {
    errors.push(
      `shared/manifest: "${program}" appears in manifest.json but is NOT in BUNDLE_ELIGIBLE_PROGRAMS — the API will never grant fallback for it, so the manifest row is dead weight. Either add to BUNDLE_ELIGIBLE_PROGRAMS or remove from manifest.`
    )
    continue
  }
  const claimedKeys = BUNDLE_PROGRAM_PLATFORM_KEYS[program] ?? []
  for (const platformKey of Object.keys(programEntry.platforms ?? {})) {
    if (!claimedKeys.includes(platformKey)) {
      errors.push(
        `shared/manifest: manifest.json declares "${program}.${platformKey}" but BUNDLE_PROGRAM_PLATFORM_KEYS doesn't list it — the API would refuse the grant on a ${platformKey} device even though the archive ships. Add the platformKey to PLATFORM_KEYS.`
      )
    }
  }
}

// (3) manifest ↔ sidecar archive parity
const expectedByKey = new Map() // platformKey -> Map<sha256, {program, ext}>
for (const [program, programEntry] of Object.entries(manifest.programs ?? {})) {
  for (const [platformKey, entry] of Object.entries(
    programEntry.platforms ?? {}
  )) {
    if (!expectedByKey.has(platformKey))
      expectedByKey.set(platformKey, new Map())
    expectedByKey
      .get(platformKey)
      .set(entry.sha256.toLowerCase(), { program, ext: entry.archiveFormat })
  }
}

for (const platformKey of SIDECAR_PLATFORM_KEYS) {
  const bundlesDir = join(
    REPO_ROOT,
    "packages",
    `device-runtime-bundles-${platformKey}`,
    "bundles"
  )
  const expected = expectedByKey.get(platformKey) ?? new Map()
  const present = new Map() // sha256 -> filename
  if (existsSync(bundlesDir) && statSync(bundlesDir).isDirectory()) {
    for (const file of readdirSync(bundlesDir)) {
      if (file === "README.md") continue
      const filePath = join(bundlesDir, file)
      if (!statSync(filePath).isFile()) continue
      const buf = readFileSync(filePath)
      const sha = createHash("sha256").update(buf).digest("hex").toLowerCase()
      present.set(sha, file)
    }
  }
  // Forward: every manifest expectation has a committed archive of
  // matching sha AND a runtime-discoverable filename. The runtime
  // probes ONLY `<sha256>.<archiveFormat>` and `<sha256>` (see
  // readPrestagedArchive in src/bundles/install.ts) — an archive
  // with correct content but a different filename passes a
  // hash-only check but is invisible to the runtime, which would
  // silently fall back to HTTPS (or fail under --require-prestaged).
  // The two-name rule below mirrors the runtime probe so audit
  // failures match operator-visible behavior.
  for (const [sha, info] of expected) {
    const presentEntry = present.get(sha)
    if (!presentEntry) {
      errors.push(
        `${platformKey}: manifest expects ${info.program}@${sha} but no archive in bundles/ has matching content sha. Run scripts/populate-device-runtime-bundles.sh to fetch.`
      )
      continue
    }
    const acceptableNames = new Set([`${sha}.${info.ext}`, sha])
    if (!acceptableNames.has(presentEntry)) {
      errors.push(
        `${platformKey}: ${info.program} archive has correct content sha ${sha} but is named "${presentEntry}". Rename to "${sha}.${info.ext}" (or "${sha}") — runtime readPrestagedArchive probes only those exact names; a non-matching filename is invisible and forces a network fetch.`
      )
    }
  }
  // Reverse: every committed archive is referenced by manifest.
  for (const [sha, filename] of present) {
    if (!expected.has(sha)) {
      errors.push(
        `${platformKey}: bundles/${filename} (sha ${sha}) is not referenced by any manifest entry. Either rebuild after a manifest bump or remove stale.`
      )
    }
  }
}

// (4) publish-script behavioral check. The bash script that hoists
// publishConfig.os/cpu to top-level and runs `npm publish` MUST
// enumerate exactly the same platformKeys this audit has built. The
// earlier shape grepped the source for the canonical glob string —
// trivially defeatable by leaving the glob in a comment while the
// real loop hardcodes a list. Now we EXECUTE the script with
// `--list-platforms`, which runs the same enumeration code path the
// real publish runs, prints platforms to stdout, and exits without
// publishing. Diffing that output against SIDECAR_PLATFORM_KEYS
// catches behavioral drift even if the source text looks fine.
const PUBLISH_SCRIPT = join(
  REPO_ROOT,
  "scripts",
  "publish-device-runtime-sidecars.sh"
)
if (!existsSync(PUBLISH_SCRIPT)) {
  errors.push(
    `publish script missing at ${PUBLISH_SCRIPT} — the registry-distribution path is undefined; restore the script or document the replacement.`
  )
} else {
  // Lazy-import to avoid pulling node:child_process when audit runs
  // without the publish-contract check (e.g. in a constrained env).
  const { spawnSync } = await import("node:child_process")
  const res = spawnSync("bash", [PUBLISH_SCRIPT, "--list-platforms"], {
    encoding: "utf-8",
    cwd: REPO_ROOT,
  })
  if (res.status !== 0) {
    errors.push(
      `publish script \`bash ${PUBLISH_SCRIPT} --list-platforms\` exited ${res.status} (stderr: ${res.stderr.trim()}). The script must support \`--list-platforms\` so audit can verify its actual enumeration matches SIDECAR_PLATFORM_KEYS.`
    )
  } else {
    const publishKeys = res.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .sort()
    // Sidecar dirs are the canonical "what gets published" — every
    // dir under packages/device-runtime-bundles-* must publish, and
    // the publish script must NOT enumerate anything else.
    const expectedPublishKeys = [...dirKeys].sort()
    if (publishKeys.join(",") !== expectedPublishKeys.join(",")) {
      const missingFromPublish = expectedPublishKeys.filter(
        (k) => !publishKeys.includes(k)
      )
      const extraInPublish = publishKeys.filter(
        (k) => !expectedPublishKeys.includes(k)
      )
      const diagnostics: string[] = []
      if (missingFromPublish.length > 0) {
        diagnostics.push(
          `would NOT publish [${missingFromPublish.join(", ")}] even though those packages/device-runtime-bundles-*/ dirs exist`
        )
      }
      if (extraInPublish.length > 0) {
        diagnostics.push(
          `would publish [${extraInPublish.join(", ")}] even though no packages/device-runtime-bundles-*/ dir exists for them`
        )
      }
      errors.push(
        `publish-device-runtime-sidecars.sh --list-platforms diverges from packages/device-runtime-bundles-* directory set: ${diagnostics.join("; ")}. Restore glob enumeration in the script.`
      )
    }
  }
}

// (5) helper binaries are NOT an npm artifact (F9c). The Go cua helper and the
// Rust fs-helper reach a device via the container image (infrastructure/
// Dockerfile.api), a repo checkout, or an explicit
// SYNAPSE_DEVICE_{CUA,FS}_HELPER_PATH — NEVER via `npm i @synapse/device-runtime`.
// npm cannot pack `../../sidecars/**` above the package root, and both consumers
// degrade gracefully (cua provider not registered; fs helper-backed features
// disabled — each now WARNs at startup, see bin.ts). This is a deliberate
// distribution decision, not a bug: the tracing program (F9) neither created nor
// worsened it. This check pins that decision so it can't be half-reversed and
// re-discovered later as a defect — it fails if a helper binary is smuggled into
// `files[]` (a SILENT no-op, since npm can't pack above the root) or if a
// `cua`/`fs-helper` key is added to bundles/manifest.json `programs` without the
// full per-platform archive channel. A deliberate reversal (option ii — per-
// platform sha256 archives staged into the six device-runtime-bundles-* packages
// and published via scripts/publish-device-runtime-sidecars.sh) must land that
// whole channel AND relax this check in the same commit, so the choice is re-made
// on purpose.
const HELPER_BINARY_RE = /synapse-device-(cua|fs)-helper/
for (const f of (main.files ?? []) as string[]) {
  if (HELPER_BINARY_RE.test(f)) {
    errors.push(
      `packages/device-runtime/package.json files[] includes "${f}" (matches a helper binary). npm cannot pack sidecar binaries above the package root, so this is a silent no-op that misrepresents the F9c distribution contract. Helpers ship via the container image, a checkout, or SYNAPSE_DEVICE_{CUA,FS}_HELPER_PATH. To ship them over npm, build the bundles/manifest.json programs channel (per-platform sha256 archives in the six device-runtime-bundles-* packages) and update this check.`
    )
  }
}
for (const program of Object.keys(manifest.programs ?? {})) {
  if (program === "cua" || program === "fs-helper") {
    errors.push(
      `bundles/manifest.json programs has a "${program}" entry — the Go/Rust helper binaries are NOT a bundles-channel program today (F9c: programs are node/python/git). A manifest row without per-platform sha256 archives staged into every device-runtime-bundles-* package (published via scripts/publish-device-runtime-sidecars.sh) leaves the API proposing a toolchain the device can't resolve. If you intend option (ii), land the full channel and relax this check.`
    )
  }
}

if (errors.length === 0) {
  console.log(
    `device-runtime sidecar audit passed: ${SIDECAR_PLATFORM_KEYS.length} sidecars — private + publishConfig os/cpu hygiene, shared ↔ manifest ↔ archive parity (filename + sha256), publish-script enumeration, helper binaries out of the npm channel (F9c). Version cohesion is guard-workspace-versions' job.`
  )
  process.exit(0)
}

console.error("device-runtime sidecar audit FAILED:")
for (const err of errors) console.error(`  - ${err}`)
process.exit(1)
