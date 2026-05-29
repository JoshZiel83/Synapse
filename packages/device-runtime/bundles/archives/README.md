# bundles/archives — pre-staged toolchain archives (air-gapped deployments)

This directory is consulted by both:

- `synapse-device install-bundles`
- `ToolchainManager.resolve()` (runtime auto-download path)

**Empty by default.** The git tree does not ship the archives here —
the per-platform `@synapse/device-runtime-bundles-*` sidecar packages
do (see `packages/device-runtime-bundles-linux-x64/bundles/` etc. at
the repo root). This directory is a secondary lookup path for
operators who want to inline archives into a custom-built
`@synapse/device-runtime` tarball rather than ship them via the
sidecar packages.

## Lookup order

`defaultPrestageDirs()` consults, first-hit-wins:

1. `SYNAPSE_DEVICE_PRESTAGED_DIR` (env override, per deployment)
2. `node_modules/@synapse/device-runtime-bundles-<host-platformKey>/bundles/`
   (the sidecar packages — standard path for `npm install @synapse/device-runtime`)
3. The runtime's own monorepo-relative
   `packages/device-runtime-bundles-*/bundles/` (dev only)
4. `<package-root>/bundles/archives/` — **this directory**

So files dropped here are the last fallback before HTTPS.

## File naming (strict)

Files MUST be named **exactly** `<sha256>.<archiveFormat>` (e.g.
`04f937e1...d0e668.zip` for git win32-x64) OR just `<sha256>` with no
extension. `<sha256>` is the lowercase hex digest from the matching
`bundles/manifest.json` entry; `<archiveFormat>` is the manifest's
declared `archiveFormat` (currently `tar.gz` or `zip`).

`readPrestagedArchive` in `src/bundles/install.ts` probes ONLY those
two filenames per (program, platformKey). A correctly-content-hashed
archive under a different name is **invisible** to the runtime — it
passes a content-only sanity check but the lookup never finds it and
the runtime falls back to HTTPS (or fails outright under
`--require-prestaged`). The sidecar audit (`npm run
audit:device-runtime-sidecars`) enforces this naming so a
misnamed file is caught before it ships.

Filename → integrity relationship:

- A correctly-named file with **wrong content** is rejected (sha256
  mismatch logged; lookup continues to the next candidate / HTTPS).
- A correctly-named file with **correct content** is the only
  combination the runtime treats as a hit.
- A wrongly-named file with correct content is **NOT** discovered —
  this is the audit-enforced contract, not a soft guideline.

The content sha256 remains the integrity gate — a tampered file
under the right name is rejected — and now the filename is also
load-bearing.

## Strict mode

`synapse-device install-bundles --require-prestaged` will fail
(rather than fall back to HTTPS) if any manifest entry has no
matching pre-staged archive in the configured directories. Use this
in CI / image-build to catch a missing archive before deployment.
The flag works in both `--require-prestaged` (bare) and
`--require-prestaged=true` forms; the bare form does not swallow the
next argv token.
