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
# Honors NPM_PUBLISH_FLAGS (e.g. `--tag=next`).

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

echo "Found ${#PLATFORMS[@]} sidecar(s): ${PLATFORMS[*]}"
echo

for plat in "${PLATFORMS[@]}"; do
  src="$ROOT/packages/device-runtime-bundles-$plat"
  if [[ ! -d "$src" ]]; then
    echo "skip: $plat — no sidecar package directory at $src"
    continue
  fi
  staging="$(mktemp -d)"
  trap 'rm -rf "$staging"' EXIT
  # Copy package contents (just the files needed for the npm tarball).
  cp -r "$src/." "$staging/"
  # Hoist publishConfig.os / publishConfig.cpu to top-level so the
  # registry filter actually fires on consumers' `npm install`.
  jq '
    .os = (.publishConfig.os // empty)
    | .cpu = (.publishConfig.cpu // empty)
    | del(.publishConfig.os, .publishConfig.cpu)
    | if (.publishConfig | length) == 0 then del(.publishConfig) else . end
  ' "$src/package.json" > "$staging/package.json"
  echo "==> publishing $plat from staging $staging"
  diff -u "$src/package.json" "$staging/package.json" || true
  ( cd "$staging" && npm publish $DRY_RUN ${NPM_PUBLISH_FLAGS:-} )
  rm -rf "$staging"
  trap - EXIT
done

echo
echo "All sidecars processed. Operators consuming @synapse/device-runtime"
echo "from the registry will now fetch only their matching @synapse/device-"
echo "runtime-bundles-<host-platformKey> tarball."
