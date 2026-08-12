#!/usr/bin/env bash
# Fail if any iOS app icon carries an alpha channel.
#
# App Store Connect rejects an iOS app icon that has one — upload fails with
# ERROR ITMS-90717 ("Invalid App Store Icon. The App Store Icon ... can't be
# transparent nor contain an alpha channel"). The artwork here is fully opaque
# already, so the channel is unused padding, but the rule is about the channel
# EXISTING, not about whether any pixel is actually transparent.
#
# This guards the SOURCE icons rather than the generated Xcode asset catalog,
# because `tauri ios init` regenerates gen/apple/ from this directory and gen/ is
# gitignored. Stripping alpha only in the generated set is undone by the next
# regeneration, on every machine and in CI — so the property has to live here to
# survive.
#
# Run directly, or via `pnpm --dir app verify:icons`.
#
# Re-strip losslessly (pixels untouched, only the channel dropped) with:
#   magick <file> -alpha off <file>

set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ios"

if ! command -v magick >/dev/null 2>&1 && ! command -v identify >/dev/null 2>&1; then
  echo "verify-no-alpha: ImageMagick not found; skipping (install with: brew install imagemagick)" >&2
  exit 0
fi

# `file` is enough to see the channel and needs no ImageMagick, but ImageMagick
# lets us also report whether any pixel was genuinely transparent — which decides
# whether stripping is lossless or would need a flatten onto a background.
identify_cmd() { if command -v magick >/dev/null 2>&1; then magick "$@"; else convert "$@"; fi; }

failed=0
count=0
for f in "$dir"/*.png; do
  [ -e "$f" ] || continue
  count=$((count + 1))
  if file "$f" | grep -q RGBA; then
    min="$(identify_cmd "$f" -alpha extract -format '%[fx:minima]' info: 2>/dev/null || echo "?")"
    if [ "$min" = "1" ]; then
      note="fully opaque, so \`-alpha off\` is lossless"
    else
      note="HAS REAL TRANSPARENCY (min alpha $min) — needs flattening onto a background, not just -alpha off"
    fi
    echo "FAIL $(basename "$f"): alpha channel present — $note" >&2
    failed=$((failed + 1))
  fi
done

if [ "$count" -eq 0 ]; then
  echo "verify-no-alpha: no icons found in $dir" >&2
  exit 1
fi

if [ "$failed" -gt 0 ]; then
  echo "" >&2
  echo "$failed of $count iOS icons would be rejected by App Store Connect (ITMS-90717)." >&2
  exit 1
fi

echo "$count iOS icons verified: no alpha channels"
