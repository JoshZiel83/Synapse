#!/usr/bin/env bash
set -euo pipefail

# Rebuild the synapse-device-fs-helper Rust sidecar before a test suite that may
# touch it, so editing the Rust source without rebuilding can't silently run
# tests against a STALE binary. cargo's fingerprinting makes this a fast no-op
# when the source is unchanged.
#
# PROFILE (1st arg, or FS_HELPER_PRETEST_PROFILE env; default "debug"):
#   - device-runtime tests resolve the binary newest-wins, so a fresh DEBUG
#     build is picked up — debug is the cheapest incremental build.
#   - the api resolver (resolveFsHelperPath) is RELEASE-FIRST: it returns the
#     first existing release binary, so rebuilding only debug would leave the
#     api running a stale release. The api suite therefore passes "release" so
#     the binary it will actually select is the one we just rebuilt.
#
# Deliberately NON-BLOCKING for contributors who only touch TypeScript, but it
# must not let a STALE binary slip through:
#   - ALLOW_MISSING_FS_HELPER=1 → skip entirely (explicit opt-out).
#   - cargo not installed AND no candidate binary on disk → skip (the
#     real-binary tests already `skip` cleanly when nothing is found).
#   - cargo not installed BUT a candidate binary the resolver would pick already
#     exists → FAIL. We can't rebuild to guarantee freshness, and the suite
#     would silently run that (possibly stale) binary rather than skip. Install
#     Rust or set ALLOW_MISSING_FS_HELPER=1 to accept the risk explicitly.
# Only a genuine BUILD FAILURE (cargo present, compile broke) is otherwise fatal.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIDECAR_DIR="$REPO_ROOT/sidecars/fs-helper"
BIN="synapse-device-fs-helper"
RELEASE_BIN="$SIDECAR_DIR/target/release/$BIN"
DEBUG_BIN="$SIDECAR_DIR/target/debug/$BIN"

profile="${1:-${FS_HELPER_PRETEST_PROFILE:-debug}}"
case "$profile" in
  debug) cargo_args=() ;;
  release) cargo_args=("--release") ;;
  *)
    echo "[pretest-fs-helper.sh] ERROR: unknown profile '$profile' (want debug|release)" >&2
    exit 2
    ;;
esac

allow_missing="${ALLOW_MISSING_FS_HELPER:-0}"

if [[ "$allow_missing" == "1" ]]; then
  echo "[pretest-fs-helper.sh] ALLOW_MISSING_FS_HELPER=1 — skipping fs-helper rebuild"
  exit 0
fi

if [[ ! -d "$SIDECAR_DIR" ]]; then
  echo "[pretest-fs-helper.sh] sidecars/fs-helper not found — skipping (tests will skip the helper-backed cases)"
  exit 0
fi

if ! command -v cargo >/dev/null 2>&1; then
  # Which candidate binaries would the consuming resolver actually pick?
  #   release profile (api, release-first) → the release binary.
  #   debug profile (device-runtime, newest-wins) → debug OR release.
  existing=()
  if [[ "$profile" == "release" ]]; then
    [[ -f "$RELEASE_BIN" ]] && existing+=("$RELEASE_BIN")
  else
    [[ -f "$DEBUG_BIN" ]] && existing+=("$DEBUG_BIN")
    [[ -f "$RELEASE_BIN" ]] && existing+=("$RELEASE_BIN")
  fi
  if [[ ${#existing[@]} -gt 0 ]]; then
    echo "[pretest-fs-helper.sh] ERROR: cargo not found but a $profile-resolvable fs-helper binary already exists:" >&2
    printf '  %s\n' "${existing[@]}" >&2
    echo "  The suite would run this (possibly STALE) binary instead of skipping. Install Rust to rebuild, or set ALLOW_MISSING_FS_HELPER=1 to run against it anyway." >&2
    exit 1
  fi
  echo "[pretest-fs-helper.sh] cargo not found and no fs-helper binary on disk — skipping (helper-backed tests will skip cleanly)"
  exit 0
fi

cd "$SIDECAR_DIR"
if cargo build "${cargo_args[@]}" 2>&1; then
  echo "[pretest-fs-helper.sh] fs-helper up to date ($profile)"
  exit 0
fi

echo "[pretest-fs-helper.sh] ERROR: fs-helper build failed. Fix the Rust source above, or set ALLOW_MISSING_FS_HELPER=1 to run tests against the existing/absent binary." >&2
exit 1
