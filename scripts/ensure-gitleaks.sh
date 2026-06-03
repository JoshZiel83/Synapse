#!/usr/bin/env bash
set -euo pipefail

# Resolve a pinned, checksum-verified gitleaks binary and print its absolute
# path to STDOUT. Everything else (progress, warnings, errors) goes to STDERR
# so callers can safely do: BIN="$(bash scripts/ensure-gitleaks.sh)"
#
# Used by .githooks/pre-commit (staged scan) and .github/workflows/secret-scan.yml
# (full-history scan) so local and CI use the exact same gitleaks version — one
# source of truth, no reliance on whatever happens to be on PATH.
#
# Behavior:
#   - Honors SYNAPSE_GITLEAKS_BIN to point at a pre-installed binary (still
#     version-checked, so a wrong build can't silently substitute).
#   - Caches the downloaded binary under a shared (not per-worktree) dir so the
#     ~40 sibling worktrees of this repo don't each re-download it.
#   - Fails closed with a clear remediation message; set SYNAPSE_SKIP_GITLEAKS=1
#     at the hook level to bypass when offline (CI still enforces).

GITLEAKS_VERSION="8.30.1"

log() { echo "[ensure-gitleaks] $*" >&2; }
die() { echo "[ensure-gitleaks] ERROR: $*" >&2; exit 1; }

# Assert a binary is EXACTLY the pinned version; echo nothing, return non-zero on mismatch.
check_version() {
  bin="$1"
  [ -x "$bin" ] || return 1
  # `gitleaks version` prints just the version string (e.g. "8.30.1") on stdout.
  # Exact match only — a substring test would accept "8.30.10" as "8.30.1".
  out="$("$bin" version 2>/dev/null | tr -d '[:space:]' || true)"
  [ "$out" = "$GITLEAKS_VERSION" ]
}

# 1) Explicit override wins, but must still match the pinned version.
if [ -n "${SYNAPSE_GITLEAKS_BIN:-}" ]; then
  if check_version "$SYNAPSE_GITLEAKS_BIN"; then
    echo "$SYNAPSE_GITLEAKS_BIN"
    exit 0
  fi
  die "SYNAPSE_GITLEAKS_BIN=$SYNAPSE_GITLEAKS_BIN is not gitleaks $GITLEAKS_VERSION."
fi

# 2) Map uname -> gitleaks release asset naming.
os_raw="$(uname -s)"
case "$os_raw" in
  Linux)   OS="linux";   EXT="tar.gz" ;;
  Darwin)  OS="darwin";  EXT="tar.gz" ;;
  MINGW*|MSYS*|CYGWIN*) OS="windows"; EXT="zip" ;;
  *) die "unsupported OS '$os_raw' — install gitleaks $GITLEAKS_VERSION manually and set SYNAPSE_GITLEAKS_BIN." ;;
esac

arch_raw="$(uname -m)"
case "$arch_raw" in
  x86_64|amd64)  ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) die "unsupported architecture '$arch_raw' — install gitleaks $GITLEAKS_VERSION manually and set SYNAPSE_GITLEAKS_BIN." ;;
esac

BIN_NAME="gitleaks"
[ "$OS" = "windows" ] && BIN_NAME="gitleaks.exe"

CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/synapse/gitleaks/${GITLEAKS_VERSION}"
BIN="${CACHE_ROOT}/${BIN_NAME}"

# 3) Cache hit?
if check_version "$BIN"; then
  echo "$BIN"
  exit 0
fi

# 4) Download + verify into the cache.
#    Asset filename uses the BARE version (no `v`); the URL path uses the TAG (with `v`).
ASSET="gitleaks_${GITLEAKS_VERSION}_${OS}_${ARCH}.${EXT}"
BASE_URL="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}"
ASSET_URL="${BASE_URL}/${ASSET}"
SUMS_URL="${BASE_URL}/gitleaks_${GITLEAKS_VERSION}_checksums.txt"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q "$1" -O "$2"; }
else
  die "neither curl nor wget found — cannot download gitleaks. Install gitleaks $GITLEAKS_VERSION manually and set SYNAPSE_GITLEAKS_BIN."
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "neither sha256sum nor shasum found — cannot verify download."
  fi
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ensure-gitleaks.XXXXXX")"
# shellcheck disable=SC2064
trap "rm -rf '$TMP'" EXIT

log "downloading gitleaks ${GITLEAKS_VERSION} (${OS}/${ARCH})…"
fetch "$ASSET_URL" "$TMP/$ASSET" || die "download failed: $ASSET_URL"
fetch "$SUMS_URL"  "$TMP/checksums.txt" || die "checksums download failed: $SUMS_URL"

# Grep the expected hash for OUR asset (don't run `sha256sum -c` on the whole
# file — it lists all 10 assets and would fail on the 9 we didn't download).
expected="$(awk -v f="$ASSET" '$2 == f || $2 == "*"f {print $1}' "$TMP/checksums.txt" | head -n1)"
[ -n "$expected" ] || die "no checksum entry for $ASSET in checksums.txt"
actual="$(sha256_of "$TMP/$ASSET")"
[ "$expected" = "$actual" ] || die "checksum mismatch for $ASSET (expected $expected, got $actual)"

log "checksum OK; extracting…"
case "$EXT" in
  tar.gz) tar -xzf "$TMP/$ASSET" -C "$TMP" "$BIN_NAME" ;;
  zip)    command -v unzip >/dev/null 2>&1 || die "unzip not found"; unzip -q "$TMP/$ASSET" "$BIN_NAME" -d "$TMP" ;;
esac
[ -f "$TMP/$BIN_NAME" ] || die "binary $BIN_NAME not found in archive"

mkdir -p "$CACHE_ROOT"
chmod +x "$TMP/$BIN_NAME"
# Atomic-ish install: move into place, then verify.
mv -f "$TMP/$BIN_NAME" "$BIN"

check_version "$BIN" || die "downloaded binary failed version check (expected $GITLEAKS_VERSION)."
log "installed: $BIN"
echo "$BIN"
