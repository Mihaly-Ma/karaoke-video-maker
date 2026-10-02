#!/bin/bash
set -euo pipefail

dmg="$1"
readme="$2"
workdir=$(mktemp -d)
mounted=false
cleanup() {
  if [[ "$mounted" == true ]]; then
    hdiutil detach "$workdir/mount" || true
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT

hdiutil convert "$dmg" -format UDRW -o "$workdir/writable.dmg"
mkdir "$workdir/mount"
hdiutil attach "$workdir/writable.dmg" -nobrowse -mountpoint "$workdir/mount"
mounted=true
cp "$readme" "$workdir/mount/README.txt"
hdiutil detach "$workdir/mount"
mounted=false
hdiutil convert "$workdir/writable.dmg" -format UDZO -o "$workdir/final.dmg"

hdiutil attach "$workdir/final.dmg" -readonly -nobrowse -mountpoint "$workdir/mount"
mounted=true
cmp "$readme" "$workdir/mount/README.txt"
hdiutil detach "$workdir/mount"
mounted=false
mv "$workdir/final.dmg" "$dmg"
