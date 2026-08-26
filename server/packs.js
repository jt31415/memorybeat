'use strict';

/**
 * Song packs, read out of the SQLite catalogue (see db.js).
 *
 * Packs used to be hardcoded arrays in this file. They are now rows, populated
 * by `npm run build-packs`, which pulls decade packs from Billboard year-end
 * charts on Wikipedia and genre packs from Last.fm.
 *
 * A track is still just metadata -- the audio comes from the iTunes Search API
 * (30s preview clips), resolved at runtime by itunes.js. title / artist are what
 * players see as the answer, so keep them clean. `query` (optional) overrides
 * the iTunes search term when the plain "title artist" lookup finds the wrong
 * recording.
 */

const crypto = require('crypto');
const db = require('./db');

/* ------------------------------------------------------------------- keys */

/**
 * Stable key used for the on-disk preview cache.
 *
 * DO NOT change the shape of this string. data/itunes-cache.json is keyed on it,
 * and every entry in there represents a real (rate-limited, slow) round trip to
 * Apple. Changing the format silently orphans the lot.
 */
function trackKey(track) {
  return `${track.title}|${track.artist}`.toLowerCase();
}

/**
 * Loose key for spotting the same song arriving from two sources -- a song can
 * chart in consecutive years, and appear in both a decade and a genre pack,
 * under slightly different artist credits.
 *
 * Deliberately lossy: parentheticals go (so "Despacito (Remix)" folds into
 * "Despacito") and only the lead artist is kept (so "featuring" credits that
 * differ between sources still match). For a guessing game those really are the
 * same answer.
 */
/** Where a credit stops being one artist and starts listing collaborators. */
const CREDIT_SPLIT = /\bfeaturing\b|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bvs\.?\b|,| & | and | x /i;

/**
 * The billed lead artist, as a readable string.
 *
 * Wikipedia credits the full line-up ("Drake featuring Wizkid and Kyla") but
 * music APIs index by the primary artist. Handing them the whole credit is not
 * merely fruitless -- Last.fm's autocorrect will match it to some obscure entry
 * and cheerfully report 5 listeners for one of the most-streamed songs ever, a
 * wrong answer that looks like a right one.
 */
function leadArtist(artist) {
  const lead = String(artist || '').split(CREDIT_SPLIT)[0].trim();
  return lead || String(artist || '').trim();
}

function dedupeKey(title, artist) {
  const norm = (s) => String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  return `${norm(title)}|${norm(leadArtist(artist))}`;
}

/** The term we hand to the iTunes Search API for a track. */
function searchTerm(track) {
  if (track.query) return track.query;
  const artist = track.artist.replace(/\s*feat\..*$/i, '').trim();
  return `${track.title} ${artist}`;
}

/* --------------------------------------------------------------- queries */

const SUMMARY_SQL = `
  SELECT p.id, p.name, p.blurb, p.icon, p.kind,
         COUNT(pt.track_id) AS count
    FROM packs p
    LEFT JOIN pack_tracks pt ON pt.pack_id = p.id
   GROUP BY p.id
   HAVING count > 0
   ORDER BY p.sort, p.name
`;

/*
 * Tracks come back most-popular-first. Nothing downstream depends on the order
 * -- difficulty.js ranks them itself, and the game shuffles -- but it means a
 * truncated read (warm.js) is the *recognisable* half of a pack rather than an
 * arbitrary half.
 */
const TRACKS_SQL = `
  SELECT t.title, t.artist, t.query, t.popularity, t.popularity_source,
         t.lastfm_listeners, t.billboard_best, t.first_year,
         pt.rank, pt.year
    FROM pack_tracks pt
    JOIN tracks t ON t.id = pt.track_id
   WHERE pt.pack_id = ?
   ORDER BY t.popularity DESC NULLS LAST, pt.rank ASC
`;

/** Strip SQL nulls so track objects look like the old hand-written literals. */
function toTrack(row) {
  const track = { title: row.title, artist: row.artist };
  if (row.query) track.query = row.query;
  if (row.popularity != null) track.popularity = row.popularity;
  if (row.year != null) track.year = row.year;
  return track;
}

// Packs change only when the build script runs, so reading them once per
// process is plenty -- and it keeps getPack() as cheap as the old array lookup,
// which matters because the game calls it per room and per pack switch.
let cache = null;

function load() {
  if (cache) return cache;
  const conn = db.open();
  const packs = conn.prepare(SUMMARY_SQL).all();
  const trackStmt = conn.prepare(TRACKS_SQL);

  const byId = new Map();
  const list = [];
  for (const row of packs) {
    const pack = {
      id: row.id,
      name: row.name,
      blurb: row.blurb || '',
      icon: row.icon || '',
      kind: row.kind || null,
      tracks: trackStmt.all(row.id).map(toTrack)
    };
    byId.set(pack.id, pack);
    list.push(pack);
  }
  cache = { list, byId };
  return cache;
}

/** Drop the in-process cache, so a rebuild is picked up without a restart. */
function reload() {
  cache = null;
  selections = new Map(); // built out of the old track arrays
  return load().list.length;
}

function allPacks() {
  return load().list;
}

function getPack(id) {
  return load().byId.get(String(id || '')) || null;
}

/* ------------------------------------------------------------- selections */

/**
 * Several packs played as one.
 *
 * A room draws from a *selection* rather than a pack: one id behaves exactly as
 * before, more than one hands the game a single merged track list. Everything
 * downstream (difficulty ranking, the shuffle, history) already works on a bare
 * `{ name, tracks }`, so a selection is shaped like a pack and nothing else has
 * to know the difference.
 */

/** Selections are memoised, for two reasons that both matter more than the merge cost:
 *
 *  - difficulty.js caches its ease scale against the track array *identity*, so
 *    a fresh array per game would re-rank the whole selection every time.
 *  - the merged list is what history keys are held against, and a room switches
 *    back and forth between the same few selections.
 */
let selections = new Map();

/** Drop ids that are not real packs, and put the rest in catalogue order.
 *
 * Canonical order is what makes a selection's key stable: picking Nineties then
 * Rock must be the same selection as picking Rock then Nineties, or the two
 * would merge, name and cache separately.
 */
function orderPacks(ids) {
  const wanted = new Set(
    (Array.isArray(ids) ? ids : [ids]).map((id) => String(id || '')).filter(Boolean)
  );
  return load().list.filter((pack) => wanted.has(pack.id));
}

/**
 * One track list out of several packs.
 *
 * Overlap between packs is real and heavy -- a song can sit in a decade pack and
 * two genre packs -- and a duplicate is not merely untidy: the same answer could
 * come up twice in one game, and the duplicate would skew the difficulty ranking
 * it takes part in. Same song, one entry; the better-scored copy wins, since
 * popularity is what difficulty ranks on and one source may simply know more
 * about it than the other.
 */
function mergeTracks(packs) {
  if (packs.length === 1) return packs[0].tracks;

  const byKey = new Map();
  for (const pack of packs) {
    for (const track of pack.tracks) {
      const key = dedupeKey(track.title, track.artist);
      const seen = byKey.get(key);
      if (!seen) {
        byKey.set(key, track);
      } else if (score(track) > score(seen)) {
        byKey.set(key, track);
      }
    }
  }
  // Most popular first, matching the order a single pack arrives in.
  return [...byKey.values()].sort((a, b) => score(b) - score(a));
}

/** Popularity for comparison purposes; unscored tracks sort last. */
function score(track) {
  return track.popularity == null ? -1 : track.popularity;
}

/**
 * What the lobby calls a selection. Beyond two packs the names stop fitting on
 * one line, so the rest become a count.
 */
function selectionName(packs) {
  if (packs.length === 1) return packs[0].name;
  if (packs.length === 2) return `${packs[0].name} + ${packs[1].name}`;
  return `${packs[0].name} + ${packs.length - 1} more`;
}

/* -------------------------------------------------- imported playlists */

/**
 * Playlists imported from Deezer or Spotify (see playlists/), held here rather
 * than in the SQLite catalogue.
 *
 * They live in this file for one reason: it makes selectPacks() the single way a
 * room gets its songs. An import is shaped exactly like a selection, so game.js,
 * difficulty.js and the history logic need no knowledge of it at all -- the
 * feature costs nothing downstream.
 *
 * In memory and not in the database on purpose. These are somebody's private
 * playlist, not catalogue: they must not appear in /api/packs for other players,
 * they must not accumulate rows forever, and the expensive part of an import --
 * the iTunes lookups -- is already cached durably in data/itunes-cache.json and
 * keyed by song rather than by playlist. So a re-import after a restart is fast
 * anyway, and nothing of value is lost.
 */

const IMPORT_PREFIX = 'pl:';

/**
 * A long TTL is safe, and that is worth explaining rather than tuning.
 *
 * A Room holds its selection as an object reference from the moment it is
 * created, so an entry expiring can never break a game in progress or a room
 * sitting in its lobby. Expiry only affects *new* rooms and pack switches, which
 * means the only cost of being generous is memory -- bounded separately by
 * IMPORT_MAX.
 */
const IMPORT_TTL_MS = 12 * 60 * 60 * 1000;

/** Ceiling on remembered imports, oldest evicted first. A thousand tracks of
 *  title/artist strings is well under a megabyte, so this is roomy. */
const IMPORT_MAX = 200;

const imports = new Map(); // id -> { selection, expires }

function isImportId(id) {
  return String(id || '').startsWith(IMPORT_PREFIX);
}

/**
 * Ids are derived from the playlist itself, not random.
 *
 * Re-importing the same playlist therefore lands on the same id and reuses the
 * existing entry -- which matters more than saving a fetch: difficulty.js caches
 * its ease scale against the track array *identity*, and history is keyed
 * against the selection, so a fresh array per import would quietly discard both.
 */
function makeImportId(source, url) {
  const hash = crypto.createHash('sha1').update(`${source}|${url}`).digest('hex');
  return `${IMPORT_PREFIX}${hash.slice(0, 12)}`;
}

/** Drop expired entries, then trim to IMPORT_MAX oldest-first. */
function sweepImports() {
  const now = Date.now();
  for (const [id, entry] of imports) {
    if (entry.expires <= now) imports.delete(id);
  }
  while (imports.size > IMPORT_MAX) {
    imports.delete(imports.keys().next().value);
  }
}

/**
 * Remember an imported playlist and hand back its selection.
 *
 * @param {{source:string, label?:string, name:string, url:string, tracks:Array}} playlist
 * @returns {{ids:string[], key:string, name:string, tracks:Array, equalWeight:boolean}}
 */
function registerImport(playlist) {
  sweepImports();

  const id = makeImportId(playlist.source, playlist.url);
  const existing = imports.get(id);
  if (existing) {
    // Refresh the deadline and reuse the array identity (see makeImportId).
    existing.expires = Date.now() + IMPORT_TTL_MS;
    return existing.selection;
  }

  const selection = {
    ids: [id],
    key: id,
    name: playlist.name,
    tracks: playlist.tracks,
    // The whole point of an import: every song equally likely, difficulty out of
    // the picture. difficulty.js ranks *within* a pack, and an imported playlist
    // has no meaningful internal fame ordering to rank against -- so asking for
    // "deep cuts" of it would be noise dressed up as a setting. See
    // game.js#orderCandidates.
    equalWeight: true,
    imported: true,
    source: playlist.source,
    url: playlist.url
  };

  imports.set(id, { selection, expires: Date.now() + IMPORT_TTL_MS });
  return selection;
}

function getImport(id) {
  const entry = imports.get(String(id || ''));
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    imports.delete(id);
    return null;
  }
  return entry.selection;
}

/**
 * @param {string[]|string} ids one or more pack ids, in any order, or a single
 *        imported-playlist id
 * @returns {{ids: string[], key: string, name: string, tracks: Array}|null}
 *          null if none of the ids name a real pack
 */
function selectPacks(ids) {
  const wanted = (Array.isArray(ids) ? ids : [ids])
    .map((id) => String(id || ''))
    .filter(Boolean);

  // An imported playlist is the *complete* pool, never one ingredient of a
  // merge. Mixing is refused rather than silently resolved: merging would
  // reintroduce catalogue popularity into a pool that is meant to be evenly
  // weighted, so the two settings would quietly contradict each other. The UI
  // presents them as alternatives; this is what enforces it.
  const importIds = wanted.filter(isImportId);
  if (importIds.length) {
    if (importIds.length > 1 || importIds.length !== wanted.length) return null;
    return getImport(importIds[0]);
  }

  const packs = orderPacks(ids);
  if (!packs.length) return null;

  const key = packs.map((p) => p.id).join('+');
  const cached = selections.get(key);
  if (cached) return cached;

  const selection = {
    ids: packs.map((p) => p.id),
    key,
    name: selectionName(packs),
    tracks: mergeTracks(packs)
  };
  selections.set(key, selection);
  return selection;
}

/**
 * Something to play, for a room that has not chosen yet.
 *
 * Rooms pick their songs from the lobby now rather than at creation, so a new
 * room arrives with no selection at all -- but Room needs a non-null pack to be
 * startable, and a lobby with nothing in it has no start button worth pressing.
 * The catalogue's first pack is the answer: it is All Time, the broadest thing
 * we have, and it was already what the old setup screen defaulted to.
 */
function defaultSelection() {
  const first = load().list[0];
  return first ? selectPacks([first.id]) : null;
}

function packSummaries() {
  return load().list.map((p) => ({
    id: p.id,
    name: p.name,
    blurb: p.blurb,
    icon: p.icon,
    kind: p.kind,
    count: p.tracks.length
  }));
}

module.exports = {
  allPacks,
  getPack,
  selectPacks,
  packSummaries,
  reload,
  searchTerm,
  trackKey,
  dedupeKey,
  leadArtist,
  defaultSelection,
  registerImport,
  getImport,
  isImportId,
  IMPORT_PREFIX
};
