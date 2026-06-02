#!/usr/bin/env bash
set -euo pipefail

# Rebuild the synapse-device-fs-helper Rust sidecar before a test suite that may
# touch it, so editing the Rust source without rebuilding can't silently run
# tests against a STALE binary. cargo's fingerprinting makes this a fast no-op
# when the source is unchanged.
#
# The guarantee on success: the binary the test's resolver will PICK is freshly
# built from the current source. The resolver (resolveSidecarPath in
# packages/device-runtime/src/builtins/fs-helper-resolve.ts) chooses, in order:
#   1. the SYNAPSE_DEVICE_FS_HELPER_PATH override, if it points at a real file;
#   2. otherwise, profile-specific on-disk candidates under sidecars/fs-helper.
# So this script must reason about BOTH — rebuilding the on-disk candidate is
# pointless if an env override shadows it with some other binary.
#
# PROFILE (1st arg, or FS_HELPER_PRETEST_PROFILE env; default "debug"):
#   - device-runtime tests resolve newest-wins → rebuild DEBUG (cheapest); the
#     freshly-built debug is then the newest, so it wins.
#   - api resolveFsHelperPath is RELEASE-FIRST → the api suite passes "release"
#     so the binary it will actually select is the one we just rebuilt.
#
# Deliberately NON-BLOCKING for contributors who only touch TypeScript, but it
# must never let a STALE/foreign binary slip through:
#   - ALLOW_MISSING_FS_HELPER=1 → skip entirely (the single explicit opt-out,
#     also the escape hatch for a deliberate env override or a Rust-less host).
#   - SYNAPSE_DEVICE_FS_HELPER_PATH set to a real file that is NOT the path this
#     profile rebuilds → FAIL: the resolver would use it over the rebuilt binary
#     and we can't vouch it's fresh (handshake only catches proto mismatch, not
#     a same-proto behaviourally-drifted helper). (A non-existent override is
#     ignored, exactly as the resolver ignores it.)
#   - cargo absent AND a candidate the resolver would pick already exists → FAIL
#     (can't rebuild to guarantee freshness). Only a genuinely empty candidate
#     set skips (the real-binary tests skip cleanly when nothing resolves).
#   - cargo present → rebuild; only a real BUILD FAILURE is fatal.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# FS_HELPER_SIDECAR_DIR is a test seam (defaults to the real sidecar dir) so the
# accompanying pretest-fs-helper.test.sh can drive the on-disk-candidate logic
# against a throwaway fixture without touching the repo's real artifacts.
SIDECAR_DIR="${FS_HELPER_SIDECAR_DIR:-$REPO_ROOT/sidecars/fs-helper}"
BIN="synapse-device-fs-helper"
RELEASE_BIN="$SIDECAR_DIR/target/release/$BIN"
DEBUG_BIN="$SIDECAR_DIR/target/debug/$BIN"
BARE_BIN="$SIDECAR_DIR/$BIN"
ENV_BIN="${SYNAPSE_DEVICE_FS_HELPER_PATH:-}"

profile="${1:-${FS_HELPER_PRETEST_PROFILE:-debug}}"
case "$profile" in
  debug) cargo_args=() ; TARGET_BIN="$DEBUG_BIN" ;;
  release) cargo_args=("--release") ; TARGET_BIN="$RELEASE_BIN" ;;
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

# Env override is resolved FIRST and shadows whatever we rebuild. If it points
# at a real file that is not the path this profile (re)builds, we cannot
# guarantee freshness — fail loud (ALLOW_MISSING_FS_HELPER=1 is the opt-out for a
# deliberate override). A non-existent override is ignored, matching the resolver.
if [[ -n "$ENV_BIN" && -f "$ENV_BIN" ]]; then
  env_real="$(realpath -m -- "$ENV_BIN")"
  target_real="$(realpath -m -- "$TARGET_BIN")"
  if [[ "$env_real" != "$target_real" ]]; then
    echo "[pretest-fs-helper.sh] ERROR: SYNAPSE_DEVICE_FS_HELPER_PATH=$ENV_BIN" >&2
    echo "  is resolved BEFORE the rebuilt $profile binary ($TARGET_BIN), so the" >&2
    echo "  suite would run that overridden (possibly stale/foreign) helper, not a" >&2
    echo "  fresh build. Unset it, point it at $TARGET_BIN, or set" >&2
    echo "  ALLOW_MISSING_FS_HELPER=1 to run against it deliberately." >&2
    exit 1
  fi
  # else: the override points at exactly the path we build — fine, continue.
fi

if ! command -v cargo >/dev/null 2>&1; then
  # Enumerate exactly the on-disk candidates the chosen profile's resolver would
  # pick, in priority order (env is handled above). A skip is only safe when the
  # set is genuinely empty; otherwise the suite would run a possibly-stale binary.
  existing=()
  if [[ "$profile" == "release" ]]; then
    # api release-first: release, debug, bare.
    [[ -f "$RELEASE_BIN" ]] && existing+=("$RELEASE_BIN")
    [[ -f "$DEBUG_BIN" ]] && existing+=("$DEBUG_BIN")
    [[ -f "$BARE_BIN" ]] && existing+=("$BARE_BIN")
  else
    # device-runtime newest-wins: debug, release.
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
