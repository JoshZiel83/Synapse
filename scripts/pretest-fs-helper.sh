#!/usr/bin/env bash
set -euo pipefail

# Rebuild the synapse-device-fs-helper Rust sidecar before a test suite that may
# touch it, so editing the Rust source without rebuilding can't silently run
# tests against a STALE binary. cargo's fingerprinting makes this a fast no-op
# when the source is unchanged.
#
# The guarantee on success: the binary the test's resolver will PICK is freshly
# built from the current source. Crucially, this script does NOT re-implement
# the resolver's candidate/priority logic in bash — that mirror drifted out of
# sync with fs-helper-resolve.ts repeatedly. Instead it asks the REAL resolver
# (via fs-helper-resolve-cli.ts, run with tsx) what each profile would pick, and
# only does I/O + cargo here.
#
# PROFILE (1st arg, or FS_HELPER_PRETEST_PROFILE env; default "debug"):
#   - debug: device-runtime tests (newest-wins) → rebuild debug (cheapest).
#   - release: api suite (release-first) passes "release" so the binary it will
#     actually select is the one we just rebuilt.
#
# Decisions (all driven by the resolver's verdict):
#   - ALLOW_MISSING_FS_HELPER=1 → skip entirely (the explicit opt-out, incl. a
#     deliberate env override or a Rust-less host).
#   - SYNAPSE_DEVICE_FS_HELPER_PATH points at a real file that is NOT the path
#     this profile builds → FAIL (the override shadows the fresh build; the
#     handshake only catches a proto mismatch, not same-proto behavioural drift).
#   - cargo present → cargo build; only a real build failure is fatal.
#   - cargo absent → FAIL if the resolver would still pick something (can't prove
#     it's fresh); skip only when nothing resolves (tests skip cleanly).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# FS_HELPER_SIDECAR_DIR is a test seam (defaults to the real sidecar dir) so the
# accompanying pretest-fs-helper.test.sh can drive the logic against a throwaway
# fixture without touching the repo's real artifacts.
SIDECAR_DIR="${FS_HELPER_SIDECAR_DIR:-$REPO_ROOT/sidecars/fs-helper}"
RESOLVE_CLI="$REPO_ROOT/packages/device-runtime/src/builtins/fs-helper-resolve-cli.ts"

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

# Ask the REAL resolver what this profile would pick. Sets RESOLVED, TARGET,
# ENV_SET, ENV_IS_TARGET. tsx runs the .ts source directly (no build needed; the
# resolver is node-builtin-only and shares the exact code the tests use).
verdict="$(npx --no-install tsx "$RESOLVE_CLI" "$profile" "$SIDECAR_DIR")" || {
  echo "[pretest-fs-helper.sh] ERROR: could not query the fs-helper resolver (tsx $RESOLVE_CLI)." >&2
  echo "  Set ALLOW_MISSING_FS_HELPER=1 to skip the freshness check." >&2
  exit 1
}
eval "$verdict"

# Env override shadows whatever we build. If it's set to a real file that is not
# the path this profile builds, we cannot guarantee freshness — fail loud.
if [[ "$ENV_SET" == "1" && "$ENV_IS_TARGET" != "1" ]]; then
  echo "[pretest-fs-helper.sh] ERROR: SYNAPSE_DEVICE_FS_HELPER_PATH ($RESOLVED)" >&2
  echo "  is resolved BEFORE the rebuilt $profile binary ($TARGET), so the suite" >&2
  echo "  would run that overridden (possibly stale/foreign) helper, not a fresh" >&2
  echo "  build. Unset it, point it at $TARGET, or set ALLOW_MISSING_FS_HELPER=1" >&2
  echo "  to run against it deliberately." >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  # No cargo to rebuild with. If the resolver would still pick something, the
  # suite would run that possibly-stale binary — fail. Skip only when nothing
  # resolves (the real-binary tests skip cleanly).
  if [[ -n "$RESOLVED" ]]; then
    echo "[pretest-fs-helper.sh] ERROR: cargo not found but the $profile resolver would run:" >&2
    echo "  $RESOLVED" >&2
    echo "  This may be STALE. Install Rust to rebuild, or set ALLOW_MISSING_FS_HELPER=1." >&2
    exit 1
  fi
  echo "[pretest-fs-helper.sh] cargo not found and nothing resolves — skipping (helper-backed tests will skip cleanly)"
  exit 0
fi

cd "$SIDECAR_DIR"
if cargo build "${cargo_args[@]}" 2>&1; then
  echo "[pretest-fs-helper.sh] fs-helper up to date ($profile)"
  exit 0
fi

echo "[pretest-fs-helper.sh] ERROR: fs-helper build failed. Fix the Rust source above, or set ALLOW_MISSING_FS_HELPER=1 to run tests against the existing/absent binary." >&2
exit 1
