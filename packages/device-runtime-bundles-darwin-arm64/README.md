# @synapse/device-runtime-bundles-darwin-arm64

Pre-staged toolchain archives for the `darwin-arm64` platformKey, consumed
by [`@synapse/device-runtime`](../device-runtime/) via the prestaged-
archive lookup path.

## How it's wired

`@synapse/device-runtime` declares this package as an
`optionalDependencies` entry, pinned to the same exact version as
the main package. The published tarball carries top-level `os` and
`cpu` fields (hoisted from `publishConfig` by
`scripts/publish-device-runtime-sidecars.sh` at publish time), so
`npm install @synapse/device-runtime` on a `darwin-arm64` host fetches THIS
package's tarball and skips the other five.

The toolchain manager then resolves bundled toolchains from
`node_modules/@synapse/device-runtime-bundles-darwin-arm64/bundles/` BEFORE
attempting any HTTPS fetch — so a fresh `npm install` is enough to
make a first-run `exec_file` (e.g. `python --version`) succeed
with **zero** outbound network calls.

## File naming (strict, audit-enforced)

`bundles/<sha256>.<archiveFormat>` — the same sha256 the production
manifest (`@synapse/device-runtime/bundles/manifest.json`) declares
for the matching (program, platformKey) entry. The runtime probes
only `<sha256>.<archiveFormat>` and `<sha256>` (no extension); the
sidecar audit (`npm run audit:device-runtime-sidecars`) verifies
every committed archive matches one of those names. A misnamed
archive — even with correct content — is invisible to the runtime
and causes a fallback to HTTPS (or a hard failure under
`--require-prestaged`), so it fires the audit red before publish.

Updates land via the rebuild-sidecar pipeline: when the production
manifest bumps a sha256, the matching sidecar archive must be
re-downloaded + re-checked-in via
`scripts/populate-device-runtime-bundles.sh` (or the runtime falls
back to HTTPS). The audit catches drift on both sides.

## Why a separate package per platform

Standard pattern for cross-platform Node tools (esbuild, swc, sharp,
prebuild-install): per-platform binaries live in per-platform
`optionalDependencies` so npm's `os` + `cpu` filters fetch only
what runs. Inlining all platform archives into the main package
would download Windows MinGit onto Linux servers and vice versa.

## Why `publishConfig.os/cpu` instead of top-level

npm 9 errors `EBADPLATFORM` on workspace dependencies whose
top-level `os`/`cpu` doesn't match the dev host, even when listed
under `optionalDependencies`. Top-level would break `npm install`
during monorepo development. So the source carries os/cpu under
`publishConfig`; the publish wrapper
(`scripts/publish-device-runtime-sidecars.sh`) hoists them to
top-level when materializing the tarball that goes to the registry.
The audit (`scripts/audit-device-runtime-sidecars.mjs`) refuses to
pass if `publishConfig.os/cpu` is missing OR if top-level is set
(which would re-introduce the EBADPLATFORM dev-install break).
