#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

app_path=""
suffix=""
volume_name="Synapse Relay"
bundle_identifier="com.synapse.relay.gui"
app_version=""
app_exec_name=""

usage() {
  cat <<'EOF' >&2
Usage: package-gui-macos.sh --app-path=<path> --suffix=<platform-suffix> [--volume-name=<name>]
EOF
  exit 64
}

for arg in "$@"; do
  case "$arg" in
    --app-path=*)
      app_path="${arg#*=}"
      ;;
    --suffix=*)
      suffix="${arg#*=}"
      ;;
    --volume-name=*)
      volume_name="${arg#*=}"
      ;;
    *)
      usage
      ;;
  esac
done

if [[ -z "$app_path" || -z "$suffix" ]]; then
  usage
fi

if [[ ! -d "$app_path" ]]; then
  echo "app bundle not found: $app_path" >&2
  exit 1
fi

app_path="$(cd "$(dirname "$app_path")" && pwd)/$(basename "$app_path")"
app_name="$(basename "$app_path")"
product_name="${app_name%.app}"
output_dir="$(pwd)"
portable_zip_name="synapse-relay-gui-${suffix}-portable.zip"
dmg_output_name="synapse-relay-gui-${suffix}.dmg"
pkg_output_name="synapse-relay-gui-${suffix}.pkg"
portable_zip="${output_dir}/${portable_zip_name}"
dmg_output="${output_dir}/${dmg_output_name}"
pkg_output="${output_dir}/${pkg_output_name}"

if [[ -f "${app_path}/Contents/Info.plist" ]]; then
  detected_bundle_identifier="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${app_path}/Contents/Info.plist" 2>/dev/null || true)"
  detected_app_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${app_path}/Contents/Info.plist" 2>/dev/null || true)"
  detected_app_exec_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "${app_path}/Contents/Info.plist" 2>/dev/null || true)"
  if [[ -n "$detected_bundle_identifier" ]]; then
    bundle_identifier="$detected_bundle_identifier"
  fi
  if [[ -n "$detected_app_version" ]]; then
    app_version="$detected_app_version"
  fi
  if [[ -n "$detected_app_exec_name" ]]; then
    app_exec_name="$detected_app_exec_name"
  fi
fi

if [[ -z "$app_version" ]]; then
  app_version="0.1.0"
fi
if [[ -z "$app_exec_name" ]]; then
  app_exec_name="${app_name%.app}"
fi

work_dir="$(mktemp -d)"
stage_dir="${work_dir}/dmg-root"
temp_dmg="${work_dir}/Synapse Relay-temp.dmg"
dmg_base="${work_dir}/Synapse Relay"
pkg_root="${work_dir}/pkg-root"
pkg_scripts="${work_dir}/pkg-scripts"
portable_zip_local="${work_dir}/${portable_zip_name}"
pkg_output_local="${work_dir}/${pkg_output_name}"
device=""

cleanup() {
  if [[ -n "$device" ]]; then
    hdiutil detach "$device" -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

node "${repo_root}/relay/scripts/prepare-gui-build-assets.mjs" --runtime-output="${app_path}/Contents/Resources/runtime"
ditto -c -k --sequesterRsrc --keepParent "$app_path" "$portable_zip_local"
rm -f "$portable_zip"
cp "$portable_zip_local" "$portable_zip"

mkdir -p "$stage_dir"
mkdir -p "$pkg_root" "$pkg_scripts"
cp -R "$app_path" "$pkg_root/"

cat > "${pkg_scripts}/preinstall" <<EOF
#!/bin/bash
set -euo pipefail

product_name="${product_name}"
app_exec_name="${app_exec_name}"
app_bundle_path="/Applications/${app_name}"
app_exec_path="\${app_bundle_path}/Contents/MacOS/\${app_exec_name}"

if pgrep -f "\${app_exec_path}" >/dev/null 2>&1 || pgrep -x "${app_exec_name}" >/dev/null 2>&1; then
  echo "\${product_name} is currently running. Quit it before installing this update." >&2
  exit 1
fi
EOF
chmod +x "${pkg_scripts}/preinstall"

pkgbuild \
  --root "$pkg_root" \
  --install-location "/Applications" \
  --identifier "$bundle_identifier" \
  --version "$app_version" \
  --scripts "$pkg_scripts" \
  "$pkg_output_local" >/dev/null

pkg_name="$(basename "$pkg_output_local")"
cp "$pkg_output_local" "$stage_dir/"
rm -f "$pkg_output"
cp "$pkg_output_local" "$pkg_output"

hdiutil create -srcfolder "$stage_dir" -volname "$volume_name" -fs HFS+ -format UDRW -ov "$temp_dmg" >/dev/null

attach_output="$(hdiutil attach -readwrite -noverify -noautoopen "$temp_dmg")"
device="$(printf '%s\n' "$attach_output" | awk '/Apple_HFS/ { print $1; exit }')"
if [[ -z "$device" ]]; then
  echo "failed to attach temporary dmg" >&2
  exit 1
fi

if [[ "${SYNAPSE_RELAY_DMG_FINDER_LAYOUT:-0}" == "1" ]]; then
  /usr/bin/osascript <<EOF || echo "warning: Finder DMG layout customization failed; continuing with default layout" >&2
tell application "Finder"
  tell disk "${volume_name}"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {120, 120, 860, 520}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 144
    set text size of viewOptions to 13
    set position of item "${pkg_name}" of container window to {360, 220}
    update without registering applications
    delay 2
    close
  end tell
end tell
EOF
fi

sync
hdiutil detach "$device" -quiet >/dev/null
device=""

hdiutil convert "$temp_dmg" -format UDZO -imagekey zlib-level=9 -ov -o "$dmg_base" >/dev/null
rm -f "$dmg_output"
cp "${dmg_base}.dmg" "$dmg_output"
