#!/bin/sh
# Seeds the /app/data volume from the image's baked-in copy.
#
# Only files that are missing are copied, so a redeploy never clobbers the
# database or the iTunes cache the running server has been writing to. Set
# MEMORYBEAT_RESEED=1 to force the image's copy to win -- that's how freshly
# rebuilt packs get onto a server that already has an older data volume.
set -e

if [ -d /app/data-seed ]; then
  mkdir -p /app/data
  for src in /app/data-seed/*; do
    [ -e "$src" ] || continue
    dest="/app/data/$(basename "$src")"
    if [ ! -e "$dest" ] || [ "$MEMORYBEAT_RESEED" = "1" ]; then
      cp "$src" "$dest"
      echo "seeded $(basename "$src")"
    fi
  done
fi

exec "$@"
