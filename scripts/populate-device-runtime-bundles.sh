#!/usr/bin/env bash
# Populates packages/device-runtime-bundles-<platformKey>/bundles/
# with each manifest entry's archive named <sha256>.<ext>. Run from
# the repo root. Idempotent — skips files that already match the
# expected sha256.
#
# Invoked manually when bumping a manifest entry sha256 (or when
# bootstrapping a fresh checkout that wants to commit the binaries
# in-tree). Operators who don't want to ship binaries via the
# monorepo can leave the sidecar bundles/ directories empty; the
# runtime will fall through to HTTPS as before.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/packages/device-runtime/bundles/manifest.json"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 required" >&2; exit 2
fi
if ! command -v sha256sum >/dev/null 2>&1; then
  echo "sha256sum required" >&2; exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl required" >&2; exit 2
fi

python3 -c "
import json, sys
m = json.load(open('$MANIFEST'))
for prog, p in m['programs'].items():
  for plat, e in p['platforms'].items():
    print(f'{prog}\t{plat}\t{e[\"sha256\"]}\t{e[\"archiveFormat\"]}\t{e[\"download\"][\"url\"]}')
" | while IFS=$'\t' read -r prog plat sha ext url; do
  dir="$ROOT/packages/device-runtime-bundles-$plat/bundles"
  if [[ ! -d "$dir" ]]; then
    echo "skip: $plat has no sidecar package at $dir" >&2
    continue
  fi
  out="$dir/${sha}.${ext}"
  if [[ -f "$out" ]]; then
    actual_sha=$(sha256sum "$out" | awk '{print $1}')
    if [[ "$actual_sha" == "$sha" ]]; then
      echo "skip: $prog/$plat already populated ($out)"
      continue
    fi
    echo "stale: removing $out (sha mismatch)"
    rm -f "$out"
  fi
  echo "fetching $prog/$plat <- $url"
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  curl -fL --retry 3 -o "$tmp" "$url"
  actual_sha=$(sha256sum "$tmp" | awk '{print $1}')
  if [[ "$actual_sha" != "$sha" ]]; then
    echo "ERROR: $prog/$plat sha256 mismatch (got $actual_sha, expected $sha)" >&2
    exit 1
  fi
  mv "$tmp" "$out"
  trap - EXIT
  echo "  ok: $out"
done

echo
echo "Sidecar archives populated. To skip the binaries entirely (lean checkout),"
echo "run: git clean -fd packages/device-runtime-bundles-*/bundles/"
