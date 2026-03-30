#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

binary_path=""
suffix=""
version=""

usage() {
  cat <<'EOF' >&2
Usage: package-gui-linux.sh --binary-path=<path> --suffix=<platform-suffix> --version=<release-version>
EOF
  exit 64
}

for arg in "$@"; do
  case "$arg" in
    --binary-path=*)
      binary_path="${arg#*=}"
      ;;
    --suffix=*)
      suffix="${arg#*=}"
      ;;
    --version=*)
      version="${arg#*=}"
      ;;
    *)
      usage
      ;;
  esac
done

if [[ -z "$binary_path" || -z "$suffix" || -z "$version" ]]; then
  usage
fi

if [[ ! -f "$binary_path" ]]; then
  echo "gui binary not found: $binary_path" >&2
  exit 1
fi

binary_path="$(cd "$(dirname "$binary_path")" && pwd)/$(basename "$binary_path")"
portable_root="synapse-relay-gui-${suffix}-portable"
portable_archive="synapse-relay-gui-${suffix}-portable.tar.gz"
deb_output="synapse-relay-gui-${suffix}.deb"
appimage_output="synapse-relay-gui-${suffix}.AppImage"

package_version="${version#v}"
if [[ ! "$package_version" =~ ^[0-9] ]]; then
  package_version="0.0.0+${package_version}"
fi
package_version="$(printf '%s' "$package_version" | sed 's/[^0-9A-Za-z.+:~-]/./g')"

appimage_arch="x86_64"
case "$suffix" in
  *arm64)
    appimage_arch="aarch64"
    ;;
esac

rm -rf "$portable_root"
mkdir -p "$portable_root"
install -m 0755 "$binary_path" "$portable_root/synapse-relay-gui"
node "${repo_root}/relay/scripts/prepare-gui-build-assets.mjs" --runtime-output="${portable_root}/runtime"
tar -czf "$portable_archive" "$portable_root"

work_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

deb_root="${work_dir}/deb-root"
install_root="${deb_root}/opt/synapse-relay-gui"
mkdir -p \
  "$install_root" \
  "${deb_root}/usr/bin" \
  "${deb_root}/usr/share/applications" \
  "${deb_root}/usr/share/icons/hicolor/256x256/apps" \
  "${deb_root}/DEBIAN"
install -m 0755 "$binary_path" "${install_root}/synapse-relay-gui"
node "${repo_root}/relay/scripts/prepare-gui-build-assets.mjs" --runtime-output="${install_root}/runtime"
install -m 0644 "${repo_root}/packages/web-next/public/synapse.png" "${deb_root}/usr/share/icons/hicolor/256x256/apps/synapse-relay-gui.png"
ln -s /opt/synapse-relay-gui/synapse-relay-gui "${deb_root}/usr/bin/synapse-relay-gui"

cat >"${deb_root}/usr/share/applications/synapse-relay-gui.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Synapse Relay
Comment=Synapse Relay Desktop Client
Exec=/opt/synapse-relay-gui/synapse-relay-gui
Icon=synapse-relay-gui
Categories=Development;Utility;
Terminal=false
StartupWMClass=Synapse Relay
EOF

cat >"${deb_root}/DEBIAN/control" <<EOF
Package: synapse-relay-gui
Version: ${package_version}
Section: utils
Priority: optional
Architecture: amd64
Maintainer: Synapse
Depends: libgtk-3-0, libwebkit2gtk-4.1-0
Description: Synapse Relay desktop client
EOF

dpkg-deb --build "$deb_root" "$deb_output"

appdir="${work_dir}/SynapseRelay.AppDir"
mkdir -p \
  "${appdir}/usr/bin" \
  "${appdir}/usr/lib/synapse-relay-gui" \
  "${appdir}/usr/share/applications" \
  "${appdir}/usr/share/icons/hicolor/256x256/apps" \
  "${appdir}/usr/share/metainfo"
install -m 0755 "$binary_path" "${appdir}/usr/bin/synapse-relay-gui-bin"
node "${repo_root}/relay/scripts/prepare-gui-build-assets.mjs" --runtime-output="${appdir}/usr/lib/synapse-relay-gui/runtime"
install -m 0644 "${repo_root}/packages/web-next/public/synapse.png" "${appdir}/usr/share/icons/hicolor/256x256/apps/synapse-relay-gui.png"

cat >"${appdir}/usr/share/applications/synapse-relay-gui.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Synapse Relay
Comment=Synapse Relay Desktop Client
Exec=synapse-relay-gui
Icon=synapse-relay-gui
Categories=Development;Utility;
Terminal=false
StartupWMClass=Synapse Relay
EOF

cat >"${appdir}/usr/share/metainfo/synapse-relay-gui.appdata.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>synapse-relay-gui.desktop</id>
  <name>Synapse Relay</name>
  <summary>Synapse Relay desktop client</summary>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>Proprietary</project_license>
  <description>
    <p>Synapse Relay desktop client with packaged runtimes for local automation and tool relay.</p>
  </description>
  <launchable type="desktop-id">synapse-relay-gui.desktop</launchable>
</component>
EOF

linuxdeploy="${work_dir}/linuxdeploy-x86_64.AppImage"
appimagetool="${work_dir}/appimagetool-x86_64.AppImage"
curl -fsSL "https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-x86_64.AppImage" -o "$linuxdeploy"
curl -fsSL "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage" -o "$appimagetool"
chmod +x "$linuxdeploy" "$appimagetool"

APPIMAGE_EXTRACT_AND_RUN=1 "$linuxdeploy" \
  --appdir "$appdir" \
  -e "${appdir}/usr/bin/synapse-relay-gui-bin" \
  -d "${appdir}/usr/share/applications/synapse-relay-gui.desktop" \
  -i "${appdir}/usr/share/icons/hicolor/256x256/apps/synapse-relay-gui.png"

cat >"${appdir}/usr/bin/synapse-relay-gui" <<'EOF'
#!/bin/sh
set -eu
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
APPDIR="$(CDPATH= cd -- "${HERE}/../.." && pwd)"
export SYNAPSE_RELAY_PACKAGED_ROOT="${APPDIR}/usr/lib/synapse-relay-gui"
exec "${APPDIR}/usr/bin/synapse-relay-gui-bin" "$@"
EOF
chmod 0755 "${appdir}/usr/bin/synapse-relay-gui"

cat >"${appdir}/AppRun" <<'EOF'
#!/bin/sh
set -eu
APPDIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export SYNAPSE_RELAY_PACKAGED_ROOT="${APPDIR}/usr/lib/synapse-relay-gui"
exec "${APPDIR}/usr/bin/synapse-relay-gui-bin" "$@"
EOF
chmod 0755 "${appdir}/AppRun"

ln -sfn usr/share/applications/synapse-relay-gui.desktop "${appdir}/synapse-relay-gui.desktop"
ln -sfn usr/share/icons/hicolor/256x256/apps/synapse-relay-gui.png "${appdir}/synapse-relay-gui.png"
ln -sfn usr/share/icons/hicolor/256x256/apps/synapse-relay-gui.png "${appdir}/.DirIcon"

APPIMAGE_EXTRACT_AND_RUN=1 ARCH="${appimage_arch}" VERSION="${package_version}" \
  "$appimagetool" "$appdir" "$appimage_output"
