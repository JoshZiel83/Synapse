#!/usr/bin/env bash
set -euo pipefail

# Containerized-LOCAL sandbox smoke test: prove the API image can actually run a
# bwrap jail under the local override's cap stack — not merely that the binaries
# EXIST. (bwrapAvailable() only existsSync-checks; a present-but-unrunnable bwrap
# would let the device register a commandline tool that then fails at spawn.)
#
# Non-destructive: uses a throwaway `compose run` container (does NOT touch a
# running api). `--build` makes it self-contained — it builds the api image with
# the baked fs-helper + bubblewrap + ripgrep first, so this can be run standalone
# (not only as a step inside deploy-sandbox-local.sh).
#
# Pass criteria (the last line is the real test): a `--unshare-net` jail starts,
# which requires CAP_SYS_ADMIN + CAP_NET_ADMIN + seccomp/apparmor unconfined.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "[sandbox-local-smoke] building api image + running bwrap exec check (throwaway container)..." >&2

docker compose \
  -f docker-compose.yml \
  -f docker-compose.sandbox-local.yml \
  run --rm --no-deps --build --entrypoint sh api -c '
    set -e
    "$SYNAPSE_DEVICE_FS_HELPER_PATH" --help >/dev/null && echo "fs-helper OK"
    rg --version >/dev/null && echo "ripgrep OK"
    /usr/bin/bwrap --version >/dev/null && echo "bwrap present"
    # Bind only the system paths that exist (mirrors sandbox-confinement.ts,
    # which existsSync-guards each ro-bind) so this does not falsely fail on a
    # slim/arm64 variant lacking e.g. /lib64.
    binds=""
    for p in /usr /bin /lib /lib64 /sbin /etc/ssl /etc/ca-certificates; do
      [ -e "$p" ] && binds="$binds --ro-bind $p $p"
    done
    # The real assertion: a no-network bwrap jail actually STARTS under the
    # local override caps. Fails loud (non-zero) if the cap stack is insufficient.
    /usr/bin/bwrap --unshare-net --unshare-pid --unshare-uts --unshare-ipc \
      --die-with-parent --new-session --proc /proc --dev /dev --tmpfs /tmp \
      $binds -- /bin/true && echo "bwrap --unshare-net EXEC OK"
  '

echo "[sandbox-local-smoke] all checks passed." >&2
