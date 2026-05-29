#!/usr/bin/env tsx
// Audits the device-runtime sidecar contract end-to-end. Three sides
// must agree; this script is the single CI gate that catches drift on
// any of them:
//
//   1. Version pins — every sidecar package.json version matches
//      @synapse/device-runtime's version, the optionalDependencies
//      pin is exact, and package-lock.json records the same exact
//      version (so `npm ci` resolves the pinned sidecar, not a
//      newer one with archives bound to a newer manifest sha).
//
//   2. publishConfig.os/cpu — every sidecar declares the (os, cpu)
//      its platformKey implies; top-level os/cpu is forbidden
//      (would trip npm 9 EBADPLATFORM on the dev install). The
//      publish wrapper (scripts/publish-device-runtime-sidecars.sh)
//      hoists these to top-level when publishing.
//
//   3. Shared ↔ manifest ↔ sidecar archive parity — BUNDLE_ELIGIBLE_
//      PROGRAMS ⊆ BUNDLE_PROGRAM_PLATFORM_KEYS, every PLATFORM_KEYS
//      entry has a real manifest row, every manifest row has a
//      committed sidecar archive matching BOTH content sha256 AND
//      one of the runtime probe filenames (`<sha>.<ext>` or
//      `<sha>`).
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
const LOCKFILE = join(REPO_ROOT, "package-lock.json")
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
const expectedVersion = main.version as string
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

// (1) version pins
for (const key of SIDECAR_PLATFORM_KEYS) {
  const pkgName = `@synapse/device-runtime-bundles-${key}`
  const declaredRange = optionalDeps[pkgName]
  if (!declaredRange) {
    errors.push(
      `${pkgName}: not in @synapse/device-runtime optionalDependencies`
    )
    continue
  }
  if (declaredRange !== expectedVersion) {
    errors.push(
      `${pkgName}: optionalDependency pinned to "${declaredRange}" but @synapse/device-runtime is "${expectedVersion}". Pin to "${expectedVersion}" so npm can't install a mismatched sidecar (which would have archives of a different vintage than the manifest expects).`
    )
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
  if (sidecarPkg.version !== expectedVersion) {
    errors.push(
      `${pkgName}: sidecar package.json version is "${sidecarPkg.version}" but main pkg is "${expectedVersion}". Bump in lockstep.`
    )
  }
  if (sidecarPkg.private === true) {
    errors.push(
      `${pkgName}: \`"private": true\` would block \`npm publish\` — remove it (the publish wrapper hoists publishConfig.os/cpu to top-level so the registry filter still restricts who installs).`
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

// (1b) lockfile parity — package-lock.json must reflect the pinned
// optionalDependencies so committed state matches what npm resolves on
// install. The earlier shape pinned package.json to "0.1.0" but left
// the lockfile recording "*", silently allowing a sidecar bump to be
// picked up at install time (defeating the version coupling
// promised by the manifest sha contract). The audit now refuses to
// pass if the lockfile is out of date — run `npm install` to
// regenerate before committing.
if (!existsSync(LOCKFILE)) {
  errors.push(
    `package-lock.json missing at ${LOCKFILE} — run \`npm install\` to generate it.`
  )
} else {
  const lock = JSON.parse(readFileSync(LOCKFILE, "utf-8"))
  // npm v9+ lockfile shape: packages["packages/device-runtime"].optionalDependencies
  const lockDevicePkg =
    lock.packages?.["packages/device-runtime"]?.optionalDependencies ?? {}
  for (const key of SIDECAR_PLATFORM_KEYS) {
    const pkgName = `@synapse/device-runtime-bundles-${key}`
    const lockRange = lockDevicePkg[pkgName]
    if (lockRange === undefined) {
      errors.push(
        `${pkgName}: missing from package-lock.json packages["packages/device-runtime"].optionalDependencies. Run \`npm install\` to regenerate.`
      )
    } else if (lockRange !== expectedVersion) {
      errors.push(
        `${pkgName}: package-lock.json records "${lockRange}" but main pkg pins "${expectedVersion}". Run \`npm install\` after bumping versions so the lockfile reflects the source.`
      )
    }
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

if (errors.length === 0) {
  console.log(
    `device-runtime sidecar audit passed: ${SIDECAR_PLATFORM_KEYS.length} sidecars pinned to ${expectedVersion}; shared ↔ manifest ↔ archive parity intact (filename + sha256).`
  )
  process.exit(0)
}

console.error("device-runtime sidecar audit FAILED:")
for (const err of errors) console.error(`  - ${err}`)
process.exit(1)
