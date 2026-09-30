#!/bin/sh
# Seeds the /app/data volume from the image's baked-in copy.
#
# Only files that are missing are copied, so a redeploy never clobbers the
# database or the iTunes cache the running server has been writing to. Set
# MEMORYBEAT_RESEED=1 to force the image's copy to win -- that's how freshly
# rebuilt packs get onto a server that already has an older data volume.
#
# A reseed only ever touches the catalogue. Players' runs, the frozen daily
# songs and the session secret live in state.db, which the image does not
# contain and this script never writes (see server/db.js).
set -e

if [ -d /app/data-seed ]; then
  mkdir -p /app/data
  for src in /app/data-seed/*; do
    [ -e "$src" ] || continue
    name="$(basename "$src")"
    dest="/app/data/$name"

    case "$name" in
      # Belt and braces: never seed state, never seed a stray WAL/SHM.
      state.db*|*-wal|*-shm) continue ;;
    esac

    if [ ! -e "$dest" ]; then
      cp "$src" "$dest"
      echo "seeded $name"
    elif [ "$MEMORYBEAT_RESEED" = "1" ]; then
      if [ "$name" = "memorybeat.db" ]; then
        # Before state.db exists, memorybeat.db still holds this server's daily
        # history -- the server moves it across on first boot. Overwriting it
        # now would destroy that history, so refuse and say why.
        if [ ! -e /app/data/state.db ]; then
          echo "NOT reseeding memorybeat.db: state.db does not exist yet, so the daily" >&2
          echo "history is still inside memorybeat.db. Deploy once without reseed, let" >&2
          echo "the server start (it moves the history to state.db), then reseed." >&2
          continue
        fi
        # The old WAL/SHM belong to the old file; left behind they would be
        # replayed onto the new one.
        rm -f "$dest-wal" "$dest-shm"
      fi
      cp "$src" "$dest"
      echo "reseeded $name"
    fi
  done
fi

exec "$@"
