#!/usr/bin/env bash
# Build a Synapse-published git binary for linux-x64 from kernel.org sources.
#
# Output: ./dist/synapse-git-<version>-linux-x64.tar.gz with shasum printed
# to stdout. The maintainer publishes this tarball to a Synapse-controlled
# release URL and copies (version, url, sha256) into
# packages/device-runtime/bundles/manifest.json (git entry).
#
# Requirements (Debian/Ubuntu): build-essential libcurl4-openssl-dev
# libexpat1-dev gettext libssl-dev libz-dev tar.
#
# WHY this script exists: bundles/manifest.json's git entry MUST point at a
# Synapse-controlled release with provenance (we ship binaries to user
# devices, so a supply-chain compromise via a third-party "portable git"
# distribution is unacceptable). Building from official kernel.org sources
# in a controlled environment is the only acceptable source.

set -euo pipefail

GIT_VERSION="${GIT_VERSION:-2.47.0}"
OUT_DIR="${OUT_DIR:-$(pwd)/dist}"
WORK_DIR="${WORK_DIR:-$(mktemp -d -t synapse-git-build-XXXX)}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"

KERNEL_BASE="https://mirrors.edge.kernel.org/pub/software/scm/git"
TARBALL="git-${GIT_VERSION}.tar.xz"
SOURCE_URL="${KERNEL_BASE}/${TARBALL}"

mkdir -p "$OUT_DIR"

echo "[git-build] version    = $GIT_VERSION"
echo "[git-build] source url = $SOURCE_URL"
echo "[git-build] work dir   = $WORK_DIR"
echo "[git-build] output dir = $OUT_DIR"

cd "$WORK_DIR"
if [[ ! -f "$TARBALL" ]]; then
  curl -fsSL -o "$TARBALL" "$SOURCE_URL"
fi

# Verify the source tarball against the kernel.org sha256sums file. This
# guards the inner step of the supply chain; the OUTER step is that the
# Synapse maintainer publishes the resulting binary tarball with a
# provenance file recording (a) the source sha256 verified here, (b) the
# build command, (c) the resulting binary sha256.
SHA_FILE="sha256sums.asc"
if [[ ! -f "$SHA_FILE" ]]; then
  curl -fsSL -o "$SHA_FILE" "${KERNEL_BASE}/sha256sums.asc" || true
fi
if grep -q "$TARBALL" "$SHA_FILE" 2>/dev/null; then
  EXPECTED_SHA=$(grep "  ${TARBALL}\$" "$SHA_FILE" | awk '{print $1}')
  ACTUAL_SHA=$(sha256sum "$TARBALL" | awk '{print $1}')
  if [[ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]]; then
    echo "[git-build] source sha256 MISMATCH: expected $EXPECTED_SHA got $ACTUAL_SHA" >&2
    exit 1
  fi
  echo "[git-build] source sha256 verified: $ACTUAL_SHA"
else
  echo "[git-build] WARNING: no sha256sums.asc entry for $TARBALL — source not verified" >&2
fi

rm -rf "git-${GIT_VERSION}"
tar -xJf "$TARBALL"
cd "git-${GIT_VERSION}"

# --without-tcltk skips GUI tools we never ship; -O2 default; the prefix is
# chosen so the runtime can use {rootDir}/{bin,libexec,share}/git-core
# layout that matches manifest entry env: {GIT_EXEC_PATH,GIT_TEMPLATE_DIR}.
INSTALL_ROOT="${WORK_DIR}/install"
rm -rf "$INSTALL_ROOT"
mkdir -p "$INSTALL_ROOT"
make -j"$JOBS" prefix="$INSTALL_ROOT" NO_GETTEXT=YesPlease NO_TCLTK=YesPlease NO_PERL=YesPlease all
make prefix="$INSTALL_ROOT" NO_GETTEXT=YesPlease NO_TCLTK=YesPlease NO_PERL=YesPlease install

# Strip symbols to shrink the tarball.
find "$INSTALL_ROOT" -type f -perm -u+x -exec strip --strip-unneeded {} + 2>/dev/null || true

ARTIFACT="synapse-git-${GIT_VERSION}-linux-x64.tar.gz"
cd "$INSTALL_ROOT"
tar -czf "${OUT_DIR}/${ARTIFACT}" .
ARTIFACT_SHA=$(sha256sum "${OUT_DIR}/${ARTIFACT}" | awk '{print $1}')

cat <<EOF
[git-build] DONE
  artifact        = ${OUT_DIR}/${ARTIFACT}
  artifact sha256 = ${ARTIFACT_SHA}
  artifact size   = $(stat -c %s "${OUT_DIR}/${ARTIFACT}" 2>/dev/null || stat -f %z "${OUT_DIR}/${ARTIFACT}")

Next step:
  1. Upload ${ARTIFACT} to the Synapse-controlled release URL.
  2. Update packages/device-runtime/bundles/manifest.json git entry with:
       version : ${GIT_VERSION}
       url     : <published URL>
       sha256  : ${ARTIFACT_SHA}
  3. Run synapse-device install-bundles to verify end-to-end download works.
EOF
