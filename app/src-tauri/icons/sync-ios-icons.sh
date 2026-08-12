#!/usr/bin/env bash
# Copy the iOS app icons into the generated Xcode asset catalog, and verify the
# result is something Xcode and App Store Connect will accept.
#
# WHY THIS EXISTS: no Tauri command does it. Tested against tauri-cli 2.11.2 by
# replacing an icon in the asset catalog with a red square and running each
# command to see which restores it:
#
#   tauri ios init   regenerates the Xcode project, plists and Contents.json,
#                    but does NOT touch the PNGs
#   tauri icon <src> writes the desktop, Windows and Android sets, and does not
#                    touch icons/ios/ OR gen/apple/ at all
#
# So icons/ios/*.png -> gen/apple/.../AppIcon.appiconset is a manual step. Miss
# it and the app builds and installs with a blank icon, which is what happened.
# gen/ is gitignored (.gitignore:28), so this bites on every fresh clone, every
# CI runner, and any time gen/ is deleted to clear a build problem.
#
# Run after `tauri ios init`, before building:
#   pnpm --dir app tauri ios init
#   pnpm --dir app sync:ios-icons
#   pnpm --dir app tauri ios build
#
# Idempotent, so running it when nothing has changed is harmless.
#
# NOTE: an already-installed app on a simulator or device caches its icon. After
# fixing the icons, delete and reinstall once or the old one persists and it
# looks like this didn't work.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/ios"
dest="$here/../gen/apple/Assets.xcassets/AppIcon.appiconset"

if [ ! -d "$dest" ]; then
  echo "sync-ios-icons: no asset catalog at" >&2
  echo "  $dest" >&2
  echo "Run \`pnpm tauri ios init\` first — it generates the Xcode project." >&2
  exit 1
fi

if [ ! -f "$dest/Contents.json" ]; then
  echo "sync-ios-icons: $dest exists but has no Contents.json." >&2
  echo "Re-run \`pnpm tauri ios init\` to regenerate the catalog." >&2
  exit 1
fi

# Copy only what Contents.json actually references. Copying the whole directory
# would also drop in files the catalog doesn't know about, which Xcode warns
# about, and would hide the more useful error below of a REFERENCED file missing.
missing=0
copied=0
while IFS= read -r name; do
  [ -n "$name" ] || continue
  if [ ! -f "$src/$name" ]; then
    echo "MISSING $name — referenced by Contents.json but absent from icons/ios/" >&2
    missing=$((missing + 1))
    continue
  fi
  cp "$src/$name" "$dest/$name"
  copied=$((copied + 1))
done < <(sed -n 's/.*"filename" *: *"\([^"]*\)".*/\1/p' "$dest/Contents.json")

if [ "$missing" -gt 0 ]; then
  echo "" >&2
  echo "$missing referenced icon(s) missing. Xcode builds an app with a blank icon" >&2
  echo "rather than failing, so this must be an error here." >&2
  exit 1
fi

if [ "$copied" -eq 0 ]; then
  echo "sync-ios-icons: Contents.json references no filenames — catalog looks broken." >&2
  exit 1
fi

# Alpha check: App Store Connect rejects an iOS icon with an alpha channel
# (ERROR ITMS-90717). The sources are kept alpha-free and verify-no-alpha.sh
# guards that, but re-check the copies so a bad file can't reach an upload
# through this path either.
if command -v magick >/dev/null 2>&1 || command -v identify >/dev/null 2>&1; then
  alpha=0
  for f in "$dest"/*.png; do
    [ -e "$f" ] || continue
    file "$f" | grep -q RGBA && { echo "FAIL $(basename "$f"): alpha channel present" >&2; alpha=$((alpha + 1)); }
  done
  if [ "$alpha" -gt 0 ]; then
    echo "" >&2
    echo "$alpha synced icon(s) carry an alpha channel and would be rejected (ITMS-90717)." >&2
    echo "Fix the sources: bash $here/verify-no-alpha.sh" >&2
    exit 1
  fi
fi

echo "$copied iOS icons synced into the Xcode asset catalog (no alpha channels)"
