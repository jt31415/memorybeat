'use strict';

/**
 * The song database.
 *
 * SQLite via node:sqlite, which ships with Node 22 -- so this adds a real
 * queryable store without adding a dependency or a native build step. The file
 * lives in data/ next to the iTunes cache.
 *
 * Two things live here: the song catalogue (every track we know about, with the
 * signals used to rank it) and the packs (named, ordered selections over that
 * catalogue). Packs reference tracks rather than owning them, so the same song
 * can sit in "1980s" and "Pop" without being stored or resolved twice.
 */

const fs = require('fs');
const path = require('path');

/*
 * node:sqlite is flagged experimental in Node 22, which prints a warning the
 * moment the module is loaded. The API we touch here (exec/prepare/run/all/get)
 * has been stable across 22.x and 24.x, so the warning is just noise on every
 * server start and every script run.
 *
 * This has to be installed BEFORE the require below -- the warning fires during
 * module load, so muting it from inside open() would always be too late.
 */
(function muteSqliteWarning() {
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const isObject = typeof warning === 'object' && warning !== null;
    const name = isObject ? warning.name : rest[0];
    const text = String(isObject ? warning.message : warning);
    if (name === 'ExperimentalWarning' && /SQLite/i.test(text)) return;
    return original.call(process, warning, ...rest);
  };
})();

const { DatabaseSync } = require('node:sqlite');

const DB_FILE = process.env.MEMORYBEAT_DB
  || path.join(__dirname, '..', 'data', 'memorybeat.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tracks (
  id            INTEGER PRIMARY KEY,
  title         TEXT    NOT NULL,
  artist        TEXT    NOT NULL,

  -- The legacy "title|artist" lowercased key. It is what data/itunes-cache.json
  -- is keyed on, so it must keep its exact old shape or every resolved preview
  -- in that cache is orphaned. See packs.trackKey().
  track_key     TEXT    NOT NULL UNIQUE,

  -- Aggressively normalised key used only to spot the same song arriving twice
  -- from different sources ("Despacito" vs "Despacito (Remix)").
  dedupe_key    TEXT    NOT NULL,

  -- Optional override for the iTunes search term when "title artist" finds the
  -- wrong recording.
  query         TEXT,

  -- Popularity signals, raw. Kept separately from the derived score so the
  -- score can be recomputed without re-fetching anything.
  lastfm_listeners INTEGER,
  lastfm_playcount INTEGER,
  billboard_best   INTEGER,   -- best (lowest) year-end chart position ever held
  billboard_years  INTEGER,   -- how many year-end charts it appeared on

  -- Derived 0..100 ranking, and which signal produced it.
  popularity        REAL,
  popularity_source TEXT,

  first_year    INTEGER,      -- earliest year we have seen it charted
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tracks_dedupe     ON tracks (dedupe_key);
CREATE INDEX IF NOT EXISTS idx_tracks_popularity ON tracks (popularity DESC);

CREATE TABLE IF NOT EXISTS packs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  blurb      TEXT,
  icon       TEXT,
  kind       TEXT,            -- 'decade' | 'genre'
  sort       INTEGER NOT NULL DEFAULT 0,
  source     TEXT,            -- provenance, for the curious
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pack_tracks (
  pack_id  TEXT    NOT NULL REFERENCES packs (id)  ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
  rank     INTEGER,           -- position within the source listing
  year     INTEGER,           -- chart year, for decade packs
  PRIMARY KEY (pack_id, track_id)
);

CREATE INDEX IF NOT EXISTS idx_pack_tracks_pack ON pack_tracks (pack_id);

-- Small key/value store for things the server has to remember across restarts
-- but that are not catalogue. Currently one row: the session-signing secret,
-- generated on first boot when SESSION_SECRET is not set, so a restart does not
-- log every daily-challenge player out. See server/auth.js.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The daily challenge's five songs, frozen.
--
-- The selection is deterministic from the date alone (see daily.js), but which
-- of the chosen songs iTunes can actually serve a preview for is not: a lookup
-- that fails at 09:00 may succeed at 21:00. Recomputing per request would hand
-- two players different songs on the same day, which is exactly the thing a
-- daily challenge cannot do. So the first request of the day settles it and
-- writes it here, and everyone else that day reads this row.
CREATE TABLE IF NOT EXISTS daily_challenges (
  day        TEXT PRIMARY KEY,   -- 'YYYY-MM-DD', UTC
  tracks     TEXT NOT NULL,      -- JSON [{title, artist, query?, year?}]
  created_at INTEGER NOT NULL
);

-- One finished run per Discord account per day. The primary key is the rule:
-- an abandoned run writes nothing and can be retried, a finished one is final.
CREATE TABLE IF NOT EXISTS daily_runs (
  day         TEXT    NOT NULL,
  discord_id  TEXT    NOT NULL,
  username    TEXT    NOT NULL,
  avatar      TEXT,               -- Discord avatar hash, for the leaderboard
  score       INTEGER NOT NULL,
  correct     INTEGER NOT NULL,
  rounds      INTEGER NOT NULL,
  total_ms    INTEGER,            -- summed solve times, correct rounds only
  best_ms     INTEGER,
  finished_at INTEGER NOT NULL,
  PRIMARY KEY (day, discord_id)
);

-- Covers the daily board directly: the ORDER BY is the index order, so today's
-- top hundred is a range scan rather than a sort of every run ever recorded.
CREATE INDEX IF NOT EXISTS idx_daily_runs_board ON daily_runs (day, score DESC, finished_at ASC);
CREATE INDEX IF NOT EXISTS idx_daily_runs_user  ON daily_runs (discord_id);
`;

let db = null;

function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = new DatabaseSync(DB_FILE);
  // WAL lets the server keep reading while the build script writes.
  db.exec('PRAGMA journal_mode = WAL');
  // Wait for a competing writer instead of failing outright: the build script
  // and a running server can genuinely overlap, and a few seconds of patience
  // is better than aborting a scrape that took minutes to get this far.
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/**
 * Run `fn` inside one transaction.
 *
 * Populating a decade is several thousand statements. Outside a transaction
 * SQLite commits each one separately, which is both far slower and leaves a
 * half-written pack behind if the run dies partway.
 */
function transaction(conn, fn) {
  conn.exec('BEGIN');
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      conn.exec('ROLLBACK');
    } catch { /* the transaction is already gone */ }
    throw err;
  }
}

/* ------------------------------------------------------------- settings kv */

function getSetting(key) {
  const row = open().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  open()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?)'
      + ' ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/** True when the catalogue has actually been populated. */
function isPopulated() {
  try {
    return open().prepare('SELECT COUNT(*) AS n FROM packs').get().n > 0;
  } catch {
    return false;
  }
}

function close() {
  if (!db) return;
  try {
    db.close();
  } catch { /* already gone */ }
  db = null;
}

module.exports = { open, close, transaction, isPopulated, getSetting, setSetting, DB_FILE };
