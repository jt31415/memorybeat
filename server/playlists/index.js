'use strict';

/**
 * Playlist import: a pasted URL in, a list of {title, artist} out.
 *
 * Every source is an adapter with the same four-part shape -- `match`,
 * `fetchPlaylist`, `available`, `unavailableReason` -- and this module is the
 * only thing that knows there is more than one. Adding Apple Music or YouTube
 * means one new file and one line in ADAPTERS; nothing downstream changes.
 *
 * The split earns its keep immediately rather than in theory: Deezer needs no
 * credentials and works now, Spotify needs a client id and secret the deployment
 * may not have, and the game must not care which of them the player used.
 *
 * What comes out of here is metadata only. Audio is resolved separately from the
 * iTunes Search API, exactly as it is for the built-in packs -- so an import
 * never depends on the source's own streaming rights, and a playlist of songs
 * Deezer will not play to us can still be a perfectly good game.
 */

const { dedupeKey } = require('../packs');

const ADAPTERS = [
  require('./deezer'),
  require('./spotify')
];

/**
 * Below this a playlist cannot fill a game. DEFAULT_ROUNDS is 10 and the
 * resolver needs slack -- iTunes will not have every track, and unlike a
 * 900-track pack a playlist has no tail to fall back on -- so this is the round
 * count plus half again. Checked against *playable* tracks, not imported ones
 * (see the import route), because that is the number a game actually draws on.
 */
const MIN_PLAYABLE = 15;

/** The adapter that recognises `input`, or null. */
function adapterFor(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  return ADAPTERS.find((adapter) => adapter.match(text)) || null;
}

/**
 * What the client needs to render the import box: which sources exist, and
 * which of them are actually usable in this deployment.
 */
function sources() {
  return ADAPTERS.map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    available: adapter.available(),
    reason: adapter.unavailableReason()
  }));
}

/**
 * Drop a playlist's own duplicates.
 *
 * People really do have the same song twice in a playlist, and a duplicate is
 * not cosmetic here: two entries are two chances to be drawn, so the same answer
 * could come up twice in one ten-round game. Keyed with packs.dedupeKey so that
 * "Despacito" and "Despacito (Remix)" fold together, matching how the built-in
 * packs are merged.
 *
 * First occurrence wins, which keeps the playlist's own order -- the order the
 * person who made it chose.
 */
function dedupe(tracks) {
  const seen = new Set();
  const out = [];
  for (const track of tracks) {
    const key = dedupeKey(track.title, track.artist);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(track);
  }
  return out;
}

/**
 * Fetch and normalise a playlist.
 *
 * @param {string} input a playlist URL from any supported source
 * @returns {Promise<{source:string, label:string, name:string, url:string,
 *                    tracks:Array, imported:number, duplicates:number,
 *                    truncated:boolean}>}
 * @throws {Error & {status:number}} status carries the HTTP code to report
 */
async function fetchPlaylist(input) {
  const adapter = adapterFor(input);
  if (!adapter) {
    throw Object.assign(
      new Error('That does not look like a playlist link. Paste a Deezer playlist URL.'),
      { status: 400 }
    );
  }
  if (!adapter.available()) {
    throw Object.assign(new Error(adapter.unavailableReason()), { status: 501 });
  }

  const raw = await adapter.fetchPlaylist(input);
  const tracks = dedupe(raw.tracks || []);

  if (!tracks.length) {
    throw Object.assign(
      new Error('That playlist has no songs we can read.'),
      { status: 422 }
    );
  }

  return {
    source: adapter.id,
    label: adapter.label,
    name: raw.name,
    url: raw.url,
    tracks,
    imported: tracks.length,
    duplicates: (raw.tracks || []).length - tracks.length,
    truncated: !!raw.truncated
  };
}

module.exports = { fetchPlaylist, adapterFor, sources, dedupe, MIN_PLAYABLE, ADAPTERS };
