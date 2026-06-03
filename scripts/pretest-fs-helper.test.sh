#!/usr/bin/env bash
# Script-level tests for pretest-fs-helper.sh. No bats in this repo, so this is a
# self-contained bash harness. Run directly: bash scripts/pretest-fs-helper.test.sh
#
# Hermetic: every case points FS_HELPER_SIDECAR_DIR at a throwaway fixture dir
# and (when simulating a Rust-less host) runs with a PATH that has coreutils but
# no cargo. The repo's real sidecars/fs-helper is never touched.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PRETEST="$SCRIPT_DIR/pretest-fs-helper.sh"
BIN="synapse-device-fs-helper"

pass=0
fail=0

# A PATH that has everything the guard needs (coreutils + node/npx/npm/tsx to run
# the resolver CLI) but NOT cargo, to simulate a Rust-less host. We symlink the
# real tools so `npx tsx` still works; only cargo is withheld.
NO_CARGO_BIN="$(mktemp -d)"
for t in bash sh dirname pwd command echo printf cat mktemp rm realpath ls \
         node npx npm env grep sed head tail cut tr; do
  s="$(command -v "$t" 2>/dev/null)" && [[ -n "$s" ]] && ln -sf "$s" "$NO_CARGO_BIN/$t" 2>/dev/null
done
# Guard: cargo must NOT be reachable via this PATH (the whole point).
if PATH="$NO_CARGO_BIN" command -v cargo >/dev/null 2>&1; then
  echo "FATAL: test harness PATH still exposes cargo; cannot simulate Rust-less host" >&2
  exit 1
fi

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

# --- cargo-PRESENT build cases incl. CARGO_TARGET_DIR (the round-6 finding) ----
# A PATH with a FAKE cargo (honors --target-dir) plus node/npx/tsx for the
# resolver CLI, so we can exercise the real build + post-build verification path
# hermetically. The fake writes a stub binary to <target-dir>/<profile>/<bin>.
FAKE_CARGO_BIN="$(mktemp -d)"
for t in bash sh dirname pwd command echo printf cat mktemp rm realpath ls node npx npm env grep sed head tail cut tr stat mkdir chmod touch; do
  s="$(command -v "$t" 2>/dev/null)" && [[ -n "$s" ]] && ln -sf "$s" "$FAKE_CARGO_BIN/$t" 2>/dev/null
done
# Honest fake cargo: respects --target-dir (overrides CARGO_TARGET_DIR like real cargo).
cat >"$FAKE_CARGO_BIN/cargo" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
profile=debug; tdir="${CARGO_TARGET_DIR:-target}"
args=("$@"); i=0
while [[ $i -lt ${#args[@]} ]]; do
  case "${args[$i]}" in
    --release) profile=release ;;
    --target-dir) i=$((i+1)); tdir="${args[$i]}" ;;
  esac
  i=$((i+1))
done
mkdir -p "$tdir/$profile"
printf '#!/bin/sh\nexit 0\n' >"$tdir/$profile/synapse-device-fs-helper"
chmod +x "$tdir/$profile/synapse-device-fs-helper"
FAKE
chmod +x "$FAKE_CARGO_BIN/cargo"

run_fake_cargo() { # <profile> [extra env assignments...]
  local prof="$1"; shift
  local fix; fix="$(mktemp -d)"
  env "PATH=$FAKE_CARGO_BIN" "FS_HELPER_SIDECAR_DIR=$fix" "$@" \
    bash "$PRETEST" "$prof" >/dev/null 2>&1
  local rc=$?
  # Report whether the pinned target got the binary, for the caller to assert.
  [[ -x "$fix/target/$prof/synapse-device-fs-helper" ]] && PINNED_OK=1 || PINNED_OK=0
  rm -rf "$fix"
  return $rc
}

# (a) normal fake build → success, binary in pinned target.
if run_fake_cargo release && [[ "$PINNED_OK" == "1" ]]; then
  echo "ok   - cargo present: build lands in pinned target (release)"; pass=$((pass+1))
else echo "FAIL - cargo present: build/pinned-target (release)"; fail=$((fail+1)); fi

# (b) CARGO_TARGET_DIR set to elsewhere, but --target-dir overrides it → success,
#     binary still in the pinned target the resolver looks at (the finding).
ALT_TD="$(mktemp -d)/elsewhere"
if run_fake_cargo release "CARGO_TARGET_DIR=$ALT_TD" \
   && [[ "$PINNED_OK" == "1" ]] && [[ ! -e "$ALT_TD/release/synapse-device-fs-helper" ]]; then
  echo "ok   - cargo present: CARGO_TARGET_DIR cannot redirect away from pinned target"; pass=$((pass+1))
else echo "FAIL - cargo present: CARGO_TARGET_DIR redirect not neutralized"; fail=$((fail+1)); fi
rm -rf "$(dirname "$ALT_TD")"

# (b2) the round-7 finding: debug profile (newest-wins) with a NEWER release
# sibling, and a cargo no-op that does NOT rewrite the debug binary (fingerprint
# hit → old mtime preserved). Without the post-build touch+exact-match the
# resolver would pick the newer release and the script would still claim fresh.
# A no-op-aware fake cargo: only (re)writes if the output is missing.
NOOP_CARGO_BIN="$(mktemp -d)"
for t in bash sh dirname pwd command echo printf cat mktemp rm realpath ls node npx npm env grep sed head tail cut tr stat mkdir chmod touch; do
  s="$(command -v "$t" 2>/dev/null)" && [[ -n "$s" ]] && ln -sf "$s" "$NOOP_CARGO_BIN/$t" 2>/dev/null
done
cat >"$NOOP_CARGO_BIN/cargo" <<'NOOP'
#!/usr/bin/env bash
set -euo pipefail
profile=debug; tdir="${CARGO_TARGET_DIR:-target}"
args=("$@"); i=0
while [[ $i -lt ${#args[@]} ]]; do
  case "${args[$i]}" in
    --release) profile=release ;;
    --target-dir) i=$((i+1)); tdir="${args[$i]}" ;;
  esac
  i=$((i+1))
done
out="$tdir/$profile/synapse-device-fs-helper"
# Fingerprint hit: leave an existing binary untouched (preserve its old mtime).
if [[ ! -e "$out" ]]; then
  mkdir -p "$tdir/$profile"
  printf '#!/bin/sh\nexit 0\n' >"$out"; chmod +x "$out"
fi
NOOP
chmod +x "$NOOP_CARGO_BIN/cargo"

NOOP_FIX="$(mktemp -d)"
mkdir -p "$NOOP_FIX/target/debug" "$NOOP_FIX/target/release"
printf '#!/bin/sh\nexit 0\n' >"$NOOP_FIX/target/debug/synapse-device-fs-helper"
chmod +x "$NOOP_FIX/target/debug/synapse-device-fs-helper"
printf '#!/bin/sh\nexit 0\n' >"$NOOP_FIX/target/release/synapse-device-fs-helper"
chmod +x "$NOOP_FIX/target/release/synapse-device-fs-helper"
# Make release strictly NEWER than debug (the shadowing setup).
touch -d "2020-01-01" "$NOOP_FIX/target/debug/synapse-device-fs-helper"
touch -d "2020-06-01" "$NOOP_FIX/target/release/synapse-device-fs-helper"
env "PATH=$NOOP_CARGO_BIN" "FS_HELPER_SIDECAR_DIR=$NOOP_FIX" bash "$PRETEST" debug >/dev/null 2>&1
noop_rc=$?
# After: the resolver (debug, newest-wins) must now pick the DEBUG target, because
# pretest touched it newest. Query via the real CLI.
noop_resolved="$(env "PATH=$NOOP_CARGO_BIN" npx --no-install tsx \
  "$REPO_ROOT/packages/device-runtime/src/builtins/fs-helper-resolve-cli.ts" debug "$NOOP_FIX" \
  2>/dev/null | sed -n "s/^RESOLVED=//p" | tr -d "'")"
if [[ "$noop_rc" == "0" && "$noop_resolved" == "$NOOP_FIX/target/debug/synapse-device-fs-helper" ]]; then
  echo "ok   - cargo no-op: newer release sibling does NOT shadow the debug build"; pass=$((pass+1))
else
  echo "FAIL - cargo no-op: debug rc=$noop_rc resolved=$noop_resolved"; fail=$((fail+1))
fi
rm -rf "$NOOP_FIX" "$NOOP_CARGO_BIN"

# (c) a BAD cargo that ignores --target-dir and writes to CARGO_TARGET_DIR only →
#     post-build existence check must FAIL (the pinned target stays empty).
BAD_CARGO_BIN="$(mktemp -d)"
for t in bash sh dirname pwd command echo printf cat mktemp rm realpath ls node npx npm env grep sed head tail cut tr stat mkdir chmod touch; do
  s="$(command -v "$t" 2>/dev/null)" && [[ -n "$s" ]] && ln -sf "$s" "$BAD_CARGO_BIN/$t" 2>/dev/null
done
cat >"$BAD_CARGO_BIN/cargo" <<'BAD'
#!/usr/bin/env bash
set -euo pipefail
profile=debug; [[ "$*" == *--release* ]] && profile=release
tdir="${CARGO_TARGET_DIR:?bad cargo needs CARGO_TARGET_DIR}"   # ignores --target-dir
mkdir -p "$tdir/$profile"
printf '#!/bin/sh\nexit 0\n' >"$tdir/$profile/synapse-device-fs-helper"
chmod +x "$tdir/$profile/synapse-device-fs-helper"
BAD
chmod +x "$BAD_CARGO_BIN/cargo"
BAD_FIX="$(mktemp -d)"; BAD_TD="$(mktemp -d)/redirected"
env "PATH=$BAD_CARGO_BIN" "FS_HELPER_SIDECAR_DIR=$BAD_FIX" "CARGO_TARGET_DIR=$BAD_TD" \
  bash "$PRETEST" release >/dev/null 2>&1
bad_rc=$?
if [[ "$bad_rc" != "0" ]]; then
  echo "ok   - cargo present: build that misses the pinned target FAILs post-build check (exit $bad_rc)"; pass=$((pass+1))
else echo "FAIL - cargo present: missed pinned target was not caught"; fail=$((fail+1)); fi
rm -rf "$BAD_FIX" "$(dirname "$BAD_TD")" "$BAD_CARGO_BIN" "$FAKE_CARGO_BIN"

# --- misc guards --------------------------------------------------------------
expect "unknown profile → exit 2" 2 present bogus "" --
ALLOW_MISSING_FS_HELPER=1 bash "$PRETEST" release >/dev/null 2>&1 \
  && { echo "ok   - ALLOW_MISSING=1 skips (exit 0)"; pass=$((pass+1)); } \
  || { echo "FAIL - ALLOW_MISSING=1 skips"; fail=$((fail+1)); }

rm -f "$ENV_EXISTING"

echo "----"
echo "pretest-fs-helper.test.sh: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
