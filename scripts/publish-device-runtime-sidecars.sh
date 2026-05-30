#!/usr/bin/env bash
# Publishes the six @synapse/device-runtime-bundles-* sidecar packages
# to the npm registry with top-level `os` / `cpu` fields so consumers'
# `npm install` filters fetch only the matching one.
#
# `publishConfig.os` / `publishConfig.cpu` is NOT auto-hoisted to the
# published tarball by `npm publish` — only npm config values (registry,
# tag, access) are. So a naive `npm publish -w <sidecar>` would push
# the unfiltered package.json and consumers would download all 6
# sidecars on every host. This wrapper materializes a temp staging
# directory per sidecar with the os/cpu hoisted, then publishes.
#
# Two reasons sidecars can't just have top-level os/cpu in-source:
#   1. npm 9 errors `EBADPLATFORM` for workspace deps with mismatched
#      os/cpu even when listed under optionalDependencies — blocking
#      the dev `npm install` outright. The publishConfig form keeps
#      the dev install working.
#   2. Sidecars are kept in `workspaces` so the dev lockfile records
#      them as resolvable workspace links (preserving full
#      `integrity`/`resolved` entries for all registry packages).
#      Top-level os/cpu would break that.
#
# Usage (run from repo root):
#   bash scripts/publish-device-runtime-sidecars.sh [--dry-run]
#
# Registry: the destination is taken from $NPM_REGISTRY (required) and
# pinned internally with `--registry`; it is NEVER taken from ambient npm
# config, because the staging dir lives under /tmp and would not see the
# repo-root .npmrc @synapse:registry mapping. A publish to public
# npmjs/yarnpkg is refused outright.
#
# Honors NPM_PUBLISH_FLAGS for extra flags (e.g. `--tag=next`), but a
# `--registry` inside it is REFUSED (npm's last-wins would let it override
# the pinned private registry).

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCES[0]:-${BASH_SOURCE[0]}}")/.." && pwd)"
DRY_RUN=""
LIST_PLATFORMS=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN="--dry-run" ;;
    # Print the platforms this script WOULD publish, one per line, and
    # exit 0 without publishing. Used by the sidecar audit to verify
    # the script's actual enumeration matches the audit's
    # SIDECAR_PLATFORM_KEYS — a stronger guarantee than grep-the-source
    # because a future regression to a hardcoded list would surface
    # here even if the canonical glob string still appears in a comment.
    --list-platforms) LIST_PLATFORMS="1" ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ -z "$LIST_PLATFORMS" ]] && ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to rewrite sidecar package.json" >&2
  exit 2
fi

# Derive the platformKey set from the actual sidecar package
# directories rather than hardcoding it — keeps this script in lockstep
# with `scripts/audit-device-runtime-sidecars.mts` (which unions the
# same dirs into its check set). A future PR that adds a new sidecar
# package (e.g. packages/device-runtime-bundles-linux-riscv64/) is
# automatically picked up here, and the audit's existing
# shared/manifest parity + lockfile parity checks ensure the same key
# is registered everywhere else BEFORE publish runs. The earlier
# hardcoded list of six platforms would silently skip new sidecars,
# leaving the registry missing the new tarball even after audit
# passed.
#
# `nullglob` is critical: without it, when no match exists bash
# returns the literal pattern string and the loop iterates over a
# bogus path. Inlining the glob (rather than passing it via a
# variable + unquoted expansion) is also critical: unquoting splits
# on whitespace BEFORE glob expansion, so a $ROOT containing spaces
# (e.g. "/tmp/synapse path/repo") would word-split first and the
# glob never matches anything. Verified the latter by repro: a
# symlink under "/tmp/synapse path/repo/wt" → this worktree made
# `--list-platforms` report "no sidecar packages found ..." until
# the inlined-quoted-glob form below was adopted.
shopt -s nullglob
PLATFORMS=()
for d in "$ROOT"/packages/device-runtime-bundles-*; do
  [[ -d "$d" ]] || continue
  plat="${d##*/device-runtime-bundles-}"
  PLATFORMS+=("$plat")
done
shopt -u nullglob
if [[ "${#PLATFORMS[@]}" -eq 0 ]]; then
  echo "no sidecar packages found under $ROOT/packages/device-runtime-bundles-*" >&2
  exit 2
fi

# --list-platforms short-circuit: print the actually-enumerated
# platforms (one per line, sorted for stable comparison) to stdout
# and exit 0. Used by scripts/audit-device-runtime-sidecars.mts as a
# behavioral check — running the same code path the real publish
# uses, instead of grepping source text. If the loop above stops
# using the canonical glob, this command's output diverges from the
# audit's SIDECAR_PLATFORM_KEYS and audit fails.
if [[ -n "$LIST_PLATFORMS" ]]; then
  printf '%s\n' "${PLATFORMS[@]}" | LC_ALL=C sort
  exit 0
fi

# --- registry guard (publish + dry-run only; --list-platforms exited above) ---
# These six are the largest, most sensitive packages; never let them slip
# to the wrong registry on a missing/foot-gun flag. The destination is
# taken from $NPM_REGISTRY and pinned with --registry AND
# --@synapse:registry below — NOT from ambient npm config.
: "${NPM_REGISTRY:?NPM_REGISTRY must be set (the private registry URL); refusing to publish sidecars}"
case "$NPM_REGISTRY" in
  *registry.npmjs.org*|*registry.npmjs.com*|*registry.yarnpkg.com*)
    echo "ERROR: NPM_REGISTRY ($NPM_REGISTRY) points at public npm; sidecars are private. Refusing." >&2
    exit 2
    ;;
esac
if [[ "${NPM_PUBLISH_FLAGS:-}" == *"--registry"* || "${NPM_PUBLISH_FLAGS:-}" == *"registry="* ]]; then
  echo "ERROR: NPM_PUBLISH_FLAGS must not contain --registry/registry= (it would override the pinned \$NPM_REGISTRY). Refusing." >&2
  exit 2
fi
if [[ "${NPM_PUBLISH_FLAGS:-}" == *"ignore-scripts"* ]]; then
  echo "ERROR: NPM_PUBLISH_FLAGS must not contain --ignore-scripts (it would skip the sidecar publish guard). Refusing." >&2
  exit 2
fi
# For SCOPED packages, the @synapse:registry mapping in an operator's
# ~/.npmrc / global npmrc OVERRIDES a plain --registry flag. Detect a
# stray scope mapping that points at public npm and warn — we always
# override it with --@synapse:registry below, but a poisoned npmrc is a
# real foot-gun worth surfacing.
AMBIENT_SCOPE_REG="$(npm config get @synapse:registry 2>/dev/null || true)"
case "$AMBIENT_SCOPE_REG" in
  *registry.npmjs.org*|*registry.npmjs.com*|*registry.yarnpkg.com*)
    echo "WARNING: ambient @synapse:registry resolves to public npm ($AMBIENT_SCOPE_REG); overriding with --@synapse:registry=$NPM_REGISTRY for this publish — but fix your ~/.npmrc." >&2
    ;;
esac

echo "Found ${#PLATFORMS[@]} sidecar(s): ${PLATFORMS[*]}"
echo

# Build a CONTROLLED userconfig that carries the AUTH token (and, as a
# belt-and-suspenders, registry pins) for the publish. We START from the
# operator's existing userconfig (so the auth token for the target host is
# preserved) and APPEND registry/scope pins LAST (last-assignment wins
# within one npmrc file). NOTE: the AUTHORITATIVE destination control is
# NOT this userconfig — it is the cmdline `--@synapse:registry=` flag on
# the publish below (cmdline beats every npmrc layer; for a scoped package
# that is the value npm routes on). This userconfig is for auth + an
# extra layer; the publish also runs from a NEUTRAL dir so no project
# .npmrc can outrank it.
CTRL_NPMRC="$(mktemp)"
trap 'rm -f "$CTRL_NPMRC"' EXIT
# Seed from the operator's userconfig if set/exists (preserves auth).
SRC_USERCONFIG="${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}"
if [[ -f "$SRC_USERCONFIG" ]]; then
  cp "$SRC_USERCONFIG" "$CTRL_NPMRC"
fi
{
  echo ""
  echo "registry=$NPM_REGISTRY"
  echo "@synapse:registry=$NPM_REGISTRY"
} >> "$CTRL_NPMRC"

for plat in "${PLATFORMS[@]}"; do
  src="$ROOT/packages/device-runtime-bundles-$plat"
  if [[ ! -d "$src" ]]; then
    echo "skip: $plat — no sidecar package directory at $src"
    continue
  fi
  staging="$(mktemp -d)"
  # Copy package contents (just the files needed for the npm tarball).
  cp -r "$src/." "$staging/"
  # Hoist publishConfig.os / publishConfig.cpu to top-level so the
  # registry filter actually fires on consumers' `npm install`. Also
  # strip `.scripts` so the staged tarball carries no prepublishOnly
  # guard (the guard exists only to block a direct `npm publish -w
  # <sidecar>`; the staged copy is the sanctioned path and ships clean).
  jq '
    .os = (.publishConfig.os // empty)
    | .cpu = (.publishConfig.cpu // empty)
    | del(.publishConfig.os, .publishConfig.cpu)
    | if (.publishConfig | length) == 0 then del(.publishConfig) else . end
    | del(.scripts)
  ' "$src/package.json" > "$staging/package.json"
  echo "==> publishing $plat from staging $staging"
  diff -u "$src/package.json" "$staging/package.json" || true
  # Pack to a tarball FIRST, then publish the tarball. npm's in-publish
  # re-pack path round-trips these very large (100-200MB) archives through
  # the cacache and can fail with TAR_BAD_ARCHIVE on a flaky/slow upload;
  # publishing a pre-built tgz avoids that.
  (
    cd "$staging" &&
      SYNAPSE_SIDECAR_PUBLISH_OK=1 npm pack >/dev/null
  )
  TGZ="$(ls "$staging"/*.tgz | head -1)"
  if [[ -z "$TGZ" ]]; then
    echo "ERROR: pack produced no tarball for $plat" >&2
    rm -rf "$staging"
    exit 1
  fi
  TGZ="$(cd "$staging" && pwd)/$(basename "$TGZ")" # absolute path
  # Publish from a NEUTRAL dir (no project .npmrc) so config precedence is
  # cmdline > userconfig. The destination is forced on the CMDLINE with the
  # `=` form of --@synapse:registry (highest precedence; for a SCOPED
  # package this is the value npm actually routes on, and it beats any
  # ambient scope mapping incl. a project/user .npmrc — verified). The
  # controlled userconfig carries only the AUTH token. A bare --registry is
  # kept for the unscoped fallback but is inert for scoped resolution.
  pubdir="$(mktemp -d)"
  (
    cd "$pubdir" &&
      SYNAPSE_SIDECAR_PUBLISH_OK=1 \
        npm publish "$TGZ" $DRY_RUN ${NPM_PUBLISH_FLAGS:-} \
          --userconfig "$CTRL_NPMRC" \
          --registry="$NPM_REGISTRY" \
          --@synapse:registry="$NPM_REGISTRY"
  )
  rm -rf "$staging" "$pubdir"
done

echo
echo "All sidecars processed. Operators consuming @synapse/device-runtime"
echo "from the registry will now fetch only their matching @synapse/device-"
echo "runtime-bundles-<host-platformKey> tarball."
