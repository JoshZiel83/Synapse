#!/usr/bin/env bash
# Script-level tests for pretest-fs-helper.sh. No bats in this repo, so this is a
# self-contained bash harness. Run directly: bash scripts/pretest-fs-helper.test.sh
#
# Hermetic: every case points FS_HELPER_SIDECAR_DIR at a throwaway fixture dir
# and (when simulating a Rust-less host) runs with a PATH that has coreutils but
# no cargo. The repo's real sidecars/fs-helper is never touched.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRETEST="$SCRIPT_DIR/pretest-fs-helper.sh"
BIN="synapse-device-fs-helper"

pass=0
fail=0

# A PATH containing coreutils but NOT cargo, to simulate a Rust-less host.
NO_CARGO_BIN="$(mktemp -d)"
for t in bash dirname pwd command echo printf cat mktemp rm realpath ls; do
  s="$(command -v "$t" 2>/dev/null)" && [[ -n "$s" ]] && ln -sf "$s" "$NO_CARGO_BIN/$t" 2>/dev/null
done

cleanup() { rm -rf "$NO_CARGO_BIN"; }
trap cleanup EXIT

# make_fixture <dir> <space-separated relative binary paths to create>
make_fixture() {
  local dir="$1"; shift
  for rel in "$@"; do
    mkdir -p "$dir/$(dirname "$rel")"
    printf '#!/bin/sh\nexit 0\n' >"$dir/$rel"
    chmod +x "$dir/$rel"
  done
}

# expect <name> <want-exit> <cargo:present|absent> <profile> <env-override-path-or-empty> -- <fixture rel bins...>
expect() {
  local name="$1" want="$2" cargo="$3" profile="$4" envpath="$5"
  shift 5
  [[ "${1:-}" == "--" ]] && shift
  local fix; fix="$(mktemp -d)"
  [[ $# -gt 0 ]] && make_fixture "$fix" "$@"

  local -a cmd=(env "FS_HELPER_SIDECAR_DIR=$fix")
  [[ -n "$envpath" ]] && cmd+=("SYNAPSE_DEVICE_FS_HELPER_PATH=$envpath")
  if [[ "$cargo" == "absent" ]]; then
    cmd+=("PATH=$NO_CARGO_BIN")
  fi
  cmd+=(bash "$PRETEST" "$profile")

  "${cmd[@]}" >/dev/null 2>&1
  local got=$?
  rm -rf "$fix"
  if [[ "$got" == "$want" ]]; then
    echo "ok   - $name (exit $got)"
    pass=$((pass + 1))
  else
    echo "FAIL - $name (want $want, got $got)"
    fail=$((fail + 1))
  fi
}

REL="target/release/$BIN"
DBG="target/debug/$BIN"
BARE="$BIN"

# A real existing file to use as an env override target.
ENV_EXISTING="$(mktemp)"; printf '#!/bin/sh\nexit 0\n' >"$ENV_EXISTING"; chmod +x "$ENV_EXISTING"

# --- env-override cases (the round-4 finding) ---------------------------------
# cargo PRESENT but env override points at a foreign existing file → FAIL,
# because the resolver would use the override, not the rebuilt binary. (cargo
# present so the only thing under test is the env guard.)
expect "env override (foreign) + cargo present, release → FAIL" 1 present release "$ENV_EXISTING" --
expect "env override (foreign) + cargo present, debug → FAIL"   1 present debug   "$ENV_EXISTING" --
# env override pointing at a NON-existent path → ignored (resolver ignores it).
# cargo absent + no on-disk binary → skip (exit 0).
expect "env override (missing path) → ignored, skip" 0 absent release "/tmp/does-not-exist-$$-xyz" --
# env override == EXACTLY the path this profile builds → the env guard must NOT
# trip (a deliberate override at the canonical location is fine). Prove it by
# message: with cargo absent + that file on disk it still FAILs the on-disk
# check, but it must NOT be the env-guard error.
ENV_AT_TARGET_FIX="$(mktemp -d)"
make_fixture "$ENV_AT_TARGET_FIX" "$REL"
out_at_target="$(env "FS_HELPER_SIDECAR_DIR=$ENV_AT_TARGET_FIX" \
  "SYNAPSE_DEVICE_FS_HELPER_PATH=$ENV_AT_TARGET_FIX/$REL" "PATH=$NO_CARGO_BIN" \
  bash "$PRETEST" release 2>&1)"
if ! grep -q "resolved BEFORE the rebuilt" <<<"$out_at_target"; then
  echo "ok   - env override == target path does NOT trip the env guard"
  pass=$((pass + 1))
else
  echo "FAIL - env override == target path wrongly tripped the env guard"
  fail=$((fail + 1))
fi
rm -rf "$ENV_AT_TARGET_FIX"
ALLOW_MISSING_FS_HELPER=1 \
  env "FS_HELPER_SIDECAR_DIR=$(mktemp -d)" "SYNAPSE_DEVICE_FS_HELPER_PATH=$ENV_EXISTING" \
  bash "$PRETEST" release >/dev/null 2>&1 \
  && { echo "ok   - ALLOW_MISSING overrides env-override guard (exit 0)"; pass=$((pass+1)); } \
  || { echo "FAIL - ALLOW_MISSING overrides env-override guard"; fail=$((fail+1)); }

# --- cargo-absent on-disk candidate cases (round-2/3 findings, regression) ----
expect "absent + release profile, only DEBUG on disk → FAIL" 1 absent release "" -- "$DBG"
expect "absent + release profile, only BARE on disk → FAIL"  1 absent release "" -- "$BARE"
expect "absent + debug profile, only RELEASE on disk → FAIL" 1 absent debug   "" -- "$REL"
expect "absent + nothing on disk → skip"                     0 absent release "" --
expect "absent + nothing on disk, debug → skip"              0 absent debug   "" --

# --- misc guards --------------------------------------------------------------
expect "unknown profile → exit 2" 2 present bogus "" --
ALLOW_MISSING_FS_HELPER=1 bash "$PRETEST" release >/dev/null 2>&1 \
  && { echo "ok   - ALLOW_MISSING=1 skips (exit 0)"; pass=$((pass+1)); } \
  || { echo "FAIL - ALLOW_MISSING=1 skips"; fail=$((fail+1)); }

rm -f "$ENV_EXISTING"

echo "----"
echo "pretest-fs-helper.test.sh: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
