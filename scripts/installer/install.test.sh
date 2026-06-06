#!/usr/bin/env bash
#
# Self-contained behavior tests for install.sh (no bats in this repo; mirrors
# the style of scripts/pretest-fs-helper.test.sh). Drives the installer in
# --dry-run with a hermetic PATH of fake tools, asserting on the DRYRUN trace
# and log lines. Run: bash scripts/installer/install.test.sh
#
# Note: -e is intentionally OFF so we can capture non-zero exits.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_SH="$REPO_ROOT/packages/api/src/modules/installer/assets/install.sh"

pass=0
fail=0
WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Fake-tool bindir: a node that reports a chosen version, plus succeed-stubs.
FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/node" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "-p" ]; then echo "${FAKE_NODE_VER:-24.16.0}"; fi
EOF
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKE_BIN/npm"
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKE_BIN/curl"
chmod +x "$FAKE_BIN"/*

# Run install.sh in dry-run with the fake bin FIRST on PATH + isolated HOME.
# $1 = test name; remaining args = installer args. Captures combined output.
OUT=""
run_installer() {
  local home="$WORK/home.$RANDOM"
  mkdir -p "$home"
  OUT="$(env PATH="$FAKE_BIN:/usr/bin:/bin" HOME="$home" \
    FAKE_NODE_VER="${FAKE_NODE_VER:-24.16.0}" \
    SYNAPSE_PRIVATE_NPM_REGISTRY="${PRIV-https://npmr.example.com/}" \
    SYNAPSE_HOME="$WORK/syn.$RANDOM" \
    bash "$INSTALL_SH" --dry-run "$@" 2>&1)"
}

assert_contains() {
  local name="$1" needle="$2"
  if printf '%s' "$OUT" | grep -qF -- "$needle"; then
    echo "ok   - $name"; pass=$((pass + 1))
  else
    echo "FAIL - $name"; echo "       expected to contain: $needle"; fail=$((fail + 1))
  fi
}
assert_not_contains() {
  local name="$1" needle="$2"
  if printf '%s' "$OUT" | grep -qF -- "$needle"; then
    echo "FAIL - $name"; echo "       expected NOT to contain: $needle"; fail=$((fail + 1))
  else
    echo "ok   - $name"; pass=$((pass + 1))
  fi
}

# ---- region + mirror selection -------------------------------------------
run_installer --target device --server https://x --code C1 --region cn --mirror ustc
assert_contains "cn+ustc: node mirror is ustc" "https://mirrors.ustc.edu.cn/node/"
assert_contains "cn+ustc: P5 toolchain mirror ustc" "p5 toolchain mirror: 'ustc'"
assert_contains "cn: third-party registry = npmmirror" "registry=https://registry.npmmirror.com/"
assert_contains "cn: @synapse pinned to private" "@synapse:registry=https://npmr.example.com/"

run_installer --target device --server https://x --code C1 --region cn
assert_contains "cn+no-mirror: default geo path picks ustc" "https://mirrors.ustc.edu.cn/node/"
assert_contains "cn+no-mirror: P5 INHERITS auto key (打通 geo)" "device toolchain mirror: ustc"

run_installer --target daemon --server https://x --api-key K --region intl
assert_contains "intl: node mirror is official" "https://nodejs.org/dist/"
assert_contains "intl: P5 official (no mirror)" "p5 toolchain mirror: 'official'"

# ---- @synapse must never point at npmjs ----------------------------------
run_installer --target device --server https://x --code C1 --region intl
assert_not_contains "@synapse:registry never npmjs" "@synapse:registry=https://registry.npmjs.org"

# ---- target → package / bin mapping + auto-pair / daemon-start -----------
run_installer --target device --server https://syn --code CODE9 --region intl
assert_contains "device installs device-runtime" "@synapse/device-runtime"
assert_contains "device auto-pair carries --server" "synapse-device pair --server https://syn --code CODE9"

run_installer --target daemon --server https://syn --api-key sk_1 --region intl
assert_contains "daemon installs remote-agent-daemon" "@synapse/remote-agent-daemon"
assert_contains "daemon foreground start with --server-url/--api-key" "synapse-remote-agent-daemon --server-url https://syn --api-key sk_1"

# ---- engine fast-path vs bootstrap ---------------------------------------
FAKE_NODE_VER=24.16.0 run_installer --target device --server https://x --code C1 --region intl
assert_contains "engines ok (24.16.0) -> reuse existing" "using existing Node"
FAKE_NODE_VER=18.20.0 run_installer --target device --server https://x --code C1 --region intl
assert_contains "engines too old (18) -> bootstrap" "bootstrapping Node 24.16.0"
FAKE_NODE_VER=22.11.0 run_installer --target device --server https://x --code C1 --region intl
assert_contains "engines 22.11 (just below) -> bootstrap" "bootstrapping Node 24.16.0"
FAKE_NODE_VER=22.12.0 run_installer --target device --server https://x --code C1 --region intl
assert_contains "engines 22.12 (boundary ok) -> reuse" "using existing Node"

# ---- self-managed prefix + userconfig ------------------------------------
FAKE_NODE_VER=24.16.0 run_installer --target device --server https://x --code C1 --region intl
assert_contains "npm uses managed --prefix" "--prefix"
assert_contains "npm uses --userconfig (no global pollution)" "--userconfig"
assert_not_contains "npm not -g to system" "npm install -g @synapse"

# ---- review: malformed registry must NOT split into extra npm argv --------
# A private-registry value containing a space (e.g. an injected
# "...  --@synapse:registry=evil") must reach npm as ONE argument, not two,
# so it cannot override the private-scope pinning. Uses a recording fake npm.
test_registry_argv_not_split() {
  local home="$WORK/regargv.$RANDOM" syn="$WORK/regargv-syn.$RANDOM"
  local bin="$WORK/regargv-bin.$RANDOM" t s
  mkdir -p "$home" "$bin"
  for t in bash sh awk sed grep mktemp cat uname dirname mkdir rm cp chmod ls printf env test sha256sum; do
    s="$(command -v "$t" 2>/dev/null)"; [ -n "$s" ] && ln -sf "$s" "$bin/$t"
  done
  printf '#!/usr/bin/env bash\n[ "$1" = "-p" ] && echo 24.16.0\n' > "$bin/node"
  cat > "$bin/npm" <<'NPM'
#!/usr/bin/env bash
c=0; for a in "$@"; do case "$a" in --@synapse:registry=*) c=$((c+1));; esac; done
echo "SYNAPSE_REGISTRY_ARGS=$c"
NPM
  chmod +x "$bin/node" "$bin/npm"
  OUT="$(env -i HOME="$home" PATH="$bin" \
    SYNAPSE_PRIVATE_NPM_REGISTRY='https://npmr.example.com/ --@synapse:registry=https://evil/' \
    SYNAPSE_HOME="$syn" \
    bash "$INSTALL_SH" --target device --server https://x --code C1 --region intl 2>&1)"
}
test_registry_argv_not_split
assert_contains "malformed registry stays one npm arg (pinning safe)" "SYNAPSE_REGISTRY_ARGS=1"
assert_not_contains "malformed registry did NOT split into two" "SYNAPSE_REGISTRY_ARGS=2"

# ---- illegal-flag fail-loud vs env warn ----------------------------------
run_installer --target device --server https://x --mirror bogus --region intl
assert_contains "explicit --mirror=bogus dies" "ERROR: --mirror: unknown key 'bogus'"

run_installer --target device --server https://x --toolchain-mirror https://evil/x --region intl
assert_contains "explicit --toolchain-mirror=URL dies" "custom URLs are not allowed"

OUT="$(env PATH="$FAKE_BIN:/usr/bin:/bin" HOME="$WORK/h.$RANDOM" \
  SYNAPSE_DEVICE_TOOLCHAIN_MIRROR=bogus \
  SYNAPSE_PRIVATE_NPM_REGISTRY="https://npmr.example.com/" SYNAPSE_HOME="$WORK/s.$RANDOM" \
  bash "$INSTALL_SH" --dry-run --target device --server https://x --code C1 --region intl 2>&1)"
assert_contains "env toolchain-mirror=bogus warns (not die)" "WARN: ignoring invalid SYNAPSE_DEVICE_TOOLCHAIN_MIRROR"
assert_contains "env toolchain-mirror=bogus falls back official" "p5 toolchain mirror: 'official'"

# ---- custom URL mirror -> P5 unset ---------------------------------------
run_installer --target device --server https://x --mirror https://my.mirror/node/ --region intl
assert_contains "custom URL used for Node" "https://my.mirror/node/"
assert_contains "custom URL -> P5 official" "p5 toolchain mirror: 'official'"

# ---- --no-modify-path overrides --write-user-npmrc -----------------------
run_installer --target device --server https://x --code C1 --region intl --write-user-npmrc --no-modify-path
assert_contains "no-modify-path skips ~/.npmrc" "skipping ~/.npmrc"

# ---- empty private registry -> die ---------------------------------------
PRIV="" run_installer --target device --server https://x --code C1 --region intl
assert_contains "empty private registry dies" "no private @synapse registry configured"

# ---- PATH persistence content (review #3: npm-global bin on PATH) ---------
# Existing-Node fast path: only the npm-global bin needs persisting.
FAKE_NODE_VER=24.16.0 run_installer --target device --server https://x --code C1 --region intl
assert_contains "PATH line includes npm-global/bin" 'npm-global/bin:$PATH'

# Bootstrapped-Node path: the bootstrapped node/<ver>/bin must ALSO be on PATH
# so the synapse-* shim's `#!/usr/bin/env node` resolves in a new shell. Needs a
# REAL bootstrap (dry-run can't fake the downloaded tarball), so build a fixture
# tarball + a curl stub that serves it, patch the embedded sha to match.
test_bootstrapped_node_path() {
  local home="$WORK/bsnode.$RANDOM" syn="$WORK/bsnode-syn.$RANDOM"
  local bin="$WORK/bsbin.$RANDOM" stageroot="$WORK/stage.$RANDOM"
  mkdir -p "$home" "$bin"
  local t s
  for t in bash sh tar gzip sha256sum shasum awk sed grep mktemp cat uname dirname mkdir rm cp chmod ls printf env test; do
    s="$(command -v "$t" 2>/dev/null)"; [ -n "$s" ] && ln -sf "$s" "$bin/$t"
  done
  # fixture tarball with bin/node + bin/npm inside (strip-components 1 layout;
  # the real Node tarball ships npm alongside node).
  mkdir -p "$stageroot/node-v24.16.0-linux-x64/bin"
  printf '#!/bin/sh\n[ "$1" = "-p" ] && echo 24.16.0\n' > "$stageroot/node-v24.16.0-linux-x64/bin/node"
  printf '#!/bin/sh\nexit 0\n' > "$stageroot/node-v24.16.0-linux-x64/bin/npm"
  chmod +x "$stageroot/node-v24.16.0-linux-x64/bin/node" "$stageroot/node-v24.16.0-linux-x64/bin/npm"
  ( cd "$stageroot" && tar -czf "$WORK/fake-node.tgz" node-v24.16.0-linux-x64 )
  local sha; sha="$(sha256sum "$WORK/fake-node.tgz" | awk '{print $1}')"
  cat > "$bin/curl" <<CURL
#!/usr/bin/env bash
out=""; while [ "\$#" -gt 0 ]; do case "\$1" in -o) out="\$2"; shift 2;; *) url="\$1"; shift;; esac; done
case "\$url" in *SHASUMS256.txt) exit 0;; *.tar.gz) cp "$WORK/fake-node.tgz" "\$out";; esac
CURL
  printf '#!/usr/bin/env bash\nexit 0\n' > "$bin/npm"
  chmod +x "$bin/curl" "$bin/npm"
  # patch the installer copy so embedded linux-x64 sha matches the fixture
  local patched="$WORK/install.patched.$RANDOM.sh"
  sed "s|2faf6a387e9b62b888e21c54f01249fb27537ffecf1842f29f4c919d0a59a0ff|$sha|" "$INSTALL_SH" > "$patched"
  # NO node on PATH -> forces bootstrap
  OUT="$(env -i HOME="$home" PATH="$bin" \
    SYNAPSE_PRIVATE_NPM_REGISTRY="https://npmr.example.com/" SYNAPSE_HOME="$syn" \
    bash "$patched" --target device --server https://x --code C1 --region intl 2>&1)"
}
test_bootstrapped_node_path
assert_contains "bootstrap: PATH includes bootstrapped node bin" "node/24.16.0/bin:"
assert_contains "bootstrap: sha256 verified" "sha256 verified"

# ---- review #5: no rc file exists -> ~/.profile is created (real, not dry) -
NO_RC_HOME="$WORK/norc.$RANDOM"
mkdir -p "$NO_RC_HOME"
env PATH="$FAKE_BIN:/usr/bin:/bin" HOME="$NO_RC_HOME" FAKE_NODE_VER=24.16.0 \
  SYNAPSE_PRIVATE_NPM_REGISTRY="https://npmr.example.com/" SYNAPSE_HOME="$WORK/norc-syn.$RANDOM" \
  bash "$INSTALL_SH" --target device --server https://x --code C1 --region intl >/dev/null 2>&1
if [ -f "$NO_RC_HOME/.profile" ] && grep -q "npm-global/bin" "$NO_RC_HOME/.profile"; then
  echo "ok   - no rc file: ~/.profile created with PATH line"; pass=$((pass + 1))
else
  echo "FAIL - no rc file: ~/.profile NOT created with PATH line"; fail=$((fail + 1))
fi

echo ""
echo "install.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
