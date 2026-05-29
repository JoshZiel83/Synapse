# device-runtime bundles

`bundles/` carries everything the device-runtime needs to materialize
managed toolchains (currently `python`, `node`, `git`) when the host
device's system PATH lacks them. The actual archive bytes live in the
six per-platform `@synapse/device-runtime-bundles-*` sidecar packages
under `packages/device-runtime-bundles-<platformKey>/bundles/`. This
directory ships:

- `manifest.json` — production manifest. Currently ships REAL working
  entries for:
  - **`node` v22.11.0** — `linux-x64`, `linux-arm64`, `darwin-x64`,
    `darwin-arm64` (sha-pinned to `nodejs.org/dist`).
  - **`python` 3.12.13+20260510** — `linux-x64`, `linux-arm64`,
    `darwin-x64`, `darwin-arm64` (sha-pinned to astral-sh/python-build-
    standalone release 20260510).
  - **`git` MinGit 2.54.0.windows.1** — `win32-x64`, `win32-arm64`
    (sha-pinned to `github.com/git-for-windows/git/releases`; vetted
    upstream portable git for Windows; GPL-2.0).

  Other (program, platformKey) combinations are NOT yet bundled:
  - `node` / `python` on Windows: Node ships `.zip` on Windows; we
    support `.zip` extraction now (used for MinGit) so adding these
    is an asset + manifest entry away — no code blocker.
  - `git` on Linux / Darwin: there is no canonical upstream portable
    git binary for those platforms. The follow-up plan is a Synapse-
    built static binary (`build-scripts/git-linux-x64.sh` + the
    `manifest.production.template.json` git stub). `git` IS in
    `BUNDLE_ELIGIBLE_PROGRAMS` (`packages/shared/src/access/policies/
commandline-normalize.ts`) but only with `win32-x64` /
    `win32-arm64` listed in `BUNDLE_PROGRAM_PLATFORM_KEYS` — so the
    API never proposes `allow_bundled_toolchain: true` for git on
    a Linux/Darwin device. Operators with no system git on those
    platforms get `program_not_found` (the honest answer) until the
    Synapse-built asset is published.

  The shared ↔ manifest ↔ committed-archive contract is enforced by
  `npm run audit:device-runtime-sidecars`:
  - BUNDLE_ELIGIBLE_PROGRAMS ⊆ BUNDLE_PROGRAM_PLATFORM_KEYS,
  - every PLATFORM_KEYS entry has a manifest row,
  - every manifest row has a sidecar archive with matching sha256
    AND a runtime-discoverable filename (`<sha256>.<archiveFormat>`
    or `<sha256>`).

- `manifest.production.template.json` — full template documenting
  entries still pending publish (currently: git Linux / Darwin). Copy
  entries back into `manifest.json` when the asset is published; also
  add the platformKey to `BUNDLE_PROGRAM_PLATFORM_KEYS` in shared in
  the same PR.

- `build-scripts/git-linux-x64.sh` — builds git from official
  kernel.org source, emits `dist/synapse-git-<ver>-linux-x64.tar.gz`
  with the sha256 you paste into `manifest.json` (and into the
  matching sidecar via `scripts/populate-device-runtime-bundles.sh`).

- `archives/` — operator-controlled secondary lookup directory. Empty
  by default; used when operators want to inline archives into a
  custom-built `@synapse/device-runtime` tarball rather than ship via
  the sidecar packages. See `archives/README.md`.

- `__fixtures__/` — tiny test archive (`fake-git-0.0.0.tar.gz`) used
  by ToolchainManager unit tests. Declares
  `download.trustedSource: "fixture-test"` so the supply-chain guard
  accepts the `fixture://fake-git` pseudo-URL in tests only.

## Supply chain

v1 is **upstream-pinning + sha-locked sidecar shipping**:

- Every `download.url` MUST use `https://` and resolve to a hostname
  on the `TRUSTED_SOURCES[trustedSource].hostnames` allow-list (see
  `src/terminal/manifest.ts`). For multi-tenant hosts (github.com)
  the trustedSource also pins a path prefix so a tampered manifest
  can't swap `astral-sh/python-build-standalone` for a different repo.
- `sha256` is verified after each archive load (sidecar disk OR
  HTTPS), before extract, before the completion marker is written. A
  mismatch deletes the partial cache so retries start clean.
- The marker file contains the verified sha256; `isHealthyCache`
  invalidates stale caches when the manifest entry's expected sha
  changes (e.g. a version bump).
- Sidecar packages ship pre-staged archives so the standard path
  (`npm install @synapse/device-runtime`) needs ZERO outbound HTTPS
  on first toolchain resolve. Sidecar tarballs published to the
  registry carry top-level `os` / `cpu` so `npm install` filters
  fetch only the matching one — see
  `scripts/publish-device-runtime-sidecars.sh`.
- Adding a new `trustedSource` value is a deliberate supply-chain
  decision documented in `manifest.ts`.

## Provisioning a device

Bundled fallback is auto-download by default. `synapse-device run`
fetches + verifies any managed toolchain entry on the first
`exec_file` invocation that needs it. Sidecar archives are checked
first; HTTPS is the fallback.

Pre-warm the cache eagerly:

```sh
synapse-device install-bundles --platform=linux-x64
```

Both subcommands share `--bundled-toolchain-dir` (default
`<XDG_CACHE_HOME>/synapse/device-toolchains`) and
`--toolchain-manifest` (default `bundles/manifest.json`).

Air-gapped / offline deployment:

```sh
# Refuse the HTTPS fallback. Every manifest entry must have a
# matching pre-staged archive (sidecar dir, env override, or
# bundles/archives). Use in CI / image-build to catch a missing
# archive before deployment.
synapse-device install-bundles --platform=linux-x64 --require-prestaged
```

`install-bundles` exit-code semantics:

- **0** — at least one program is now usable (installed OR already
  installed cache hit) AND nothing failed.
- **1** — anything in `failed[]`, OR nothing usable on disk after the
  run (cross-platform install where every program was unhealthy-
  skipped for the target platform). The error message lists the
  counts so deployment systems can distinguish "manifest matrix
  incomplete" from "operator typo".
- `--strict` additionally fails if ANY entry was unhealthy-skipped
  (useful for CI gating against partial coverage).

`install-bundles` accepts `--platform=auto` (host platform + host
arch), `--platform=<platform>` (host arch), or
`--platform=<platform>-<arch>` (explicit). `--arch=<arch>` overrides
the arch portion.

## Cache layout

Each program lives at:

```
<toolchainDir>/<name>-<version>-<platformKey>/
```

The `<platformKey>` suffix prevents cross-arch cache pollution on
machines that occasionally cross-install (e.g.
`install-bundles --platform=linux-arm64` on an x64 build host). The
`.synapse-toolchain-ok` marker inside contains the verified sha256;
`isHealthyCache` re-reads it on every resolve and rejects stale
caches when the manifest entry's expected sha256 changes.

## Adding a new (program, platformKey)

1. Publish the asset upstream (Synapse-built or vetted third-party)
   with a verified sha256. The hostname must be on a `TRUSTED_SOURCES`
   allow-list — extend `TRUSTED_SOURCES` in
   `src/terminal/manifest.ts` if it's a new upstream (supply-chain
   change requiring code review).
2. Add the entry to `manifest.json`. Set `download.trustedSource`
   explicitly so the back-compat fallback never gets used.
3. Add the program (normalized form — `python` not `python3`) to
   `BUNDLE_ELIGIBLE_PROGRAMS` AND the new platformKey to
   `BUNDLE_PROGRAM_PLATFORM_KEYS` in
   `packages/shared/src/access/policies/commandline-normalize.ts`.
   Same PR — drift between these and `manifest.json` fires the
   `audit:device-runtime-sidecars` red.
4. Run `scripts/populate-device-runtime-bundles.sh` to fetch the
   archive into the matching sidecar `bundles/` directory. The
   archive lands as `<sha256>.<archiveFormat>` — the runtime probes
   that exact filename. Commit it.
5. Bump main pkg + sidecar versions in lockstep (audit enforces).

## Licenses

- `node`: MIT (https://github.com/nodejs/node/blob/main/LICENSE)
- `python` (python-build-standalone): PSF-2.0 base + various
  (https://github.com/astral-sh/python-build-standalone/blob/main/LICENSE.md)
- `git` (MinGit Windows, git-for-windows): GPL-2.0
  (https://github.com/git-for-windows/git/blob/main/COPYING)
- `git` (Synapse-built Linux/Darwin, when published): GPL-2.0
  (kernel.org/pub/software/scm/git; see COPYING in source tarball)

The sidecar packages embed each archive's license per LICENSE
metadata in the manifest; per-archive provenance (source URL, build
command, output sha256) is recorded next to the published asset.
