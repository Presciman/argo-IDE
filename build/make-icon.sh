#!/bin/bash
# Regenerate the app icon from a square source image.
#
#   ./build/make-icon.sh ~/Downloads/argo_icon.png
#
# Produces build/icon.png (1024pt, for the dev dock) and build/icon.icns
# (every size Finder and the Dock ask for). make-icon.swift does the real
# work: trimming the source's baked black border, insetting it on Apple's
# 1024/824 icon grid, and masking it to the system squircle.
set -euo pipefail

src="${1:-$HOME/Downloads/argo_icon.png}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ -f "$src" ] || { echo "no such source image: $src" >&2; exit 1; }

swift "$here/make-icon.swift" "$src" "$here/icon.png"

# .iconset is an intermediate for iconutil; it is gitignored.
set="$here/icon.iconset"
rm -rf "$set"
mkdir -p "$set"

# name:pixels — @2x entries are the same pixel count as the next size up.
for entry in \
  16x16:16 16x16@2x:32 32x32:32 32x32@2x:64 \
  128x128:128 128x128@2x:256 256x256:256 256x256@2x:512 \
  512x512:512 512x512@2x:1024
do
  name="${entry%%:*}"
  px="${entry##*:}"
  sips -z "$px" "$px" "$here/icon.png" --out "$set/icon_$name.png" >/dev/null
done

iconutil -c icns "$set" -o "$here/icon.icns"
rm -rf "$set"

echo "wrote $here/icon.icns and $here/icon.png"
