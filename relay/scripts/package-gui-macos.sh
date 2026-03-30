#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

app_path=""
suffix=""
volume_name="Synapse Relay"

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
portable_zip="synapse-relay-gui-${suffix}-portable.zip"
dmg_output="synapse-relay-gui-${suffix}.dmg"

node "${repo_root}/relay/scripts/prepare-gui-build-assets.mjs" --runtime-output="${app_path}/Contents/Resources/runtime"
ditto -c -k --sequesterRsrc --keepParent "$app_path" "$portable_zip"

work_dir="$(mktemp -d)"
stage_dir="${work_dir}/dmg-root"
temp_dmg="${work_dir}/Synapse Relay-temp.dmg"
dmg_base="${work_dir}/Synapse Relay"
device=""

cleanup() {
  if [[ -n "$device" ]]; then
    hdiutil detach "$device" -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

mkdir -p "$stage_dir"
cp -R "$app_path" "$stage_dir/"
ln -s /Applications "$stage_dir/Applications"

hdiutil create -srcfolder "$stage_dir" -volname "$volume_name" -fs HFS+ -format UDRW -ov "$temp_dmg" >/dev/null

attach_output="$(hdiutil attach -readwrite -noverify -noautoopen "$temp_dmg")"
device="$(printf '%s\n' "$attach_output" | awk '/Apple_HFS/ { print $1; exit }')"
if [[ -z "$device" ]]; then
  echo "failed to attach temporary dmg" >&2
  exit 1
fi

/usr/bin/osascript <<EOF
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
    set position of item "${app_name}" of container window to {190, 220}
    set position of item "Applications" of container window to {540, 220}
    update without registering applications
    delay 2
    close
  end tell
end tell
EOF

sync
hdiutil detach "$device" -quiet >/dev/null
device=""

hdiutil convert "$temp_dmg" -format UDZO -imagekey zlib-level=9 -ov -o "$dmg_base" >/dev/null
mv "${dmg_base}.dmg" "$dmg_output"
