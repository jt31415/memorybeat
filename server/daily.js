'use strict';

/**
 * The daily challenge: five songs, the same five for everybody, one run each.
 *
 * Everything here exists to defend one property -- that two people playing on
 * the same day played the *same game*. Without it the leaderboard compares
 * scores that were never comparable, and the whole mode is decoration.
 *
 * Which is harder than it sounds, because the song list has two sources of
 * variation and only one of them is under our control:
 *
 *   - The *choice* is deterministic. A seeded shuffle of the easy end of the
 *     All Time pack, seeded from the date, so the candidate order is a pure
 *     function of the day and can be recomputed anywhere, any time.
 *   - Whether a chosen song is *playable* is not. iTunes is rate limited and
 *     occasionally just does not have a track; a lookup that fails at 09:00 can
 *     succeed at 21:00. So the first request of the day walks the candidate
 *     order, settles on five it can actually serve, and writes that list to the
 *     database. Every later request that day reads the row. The seed decides
 *     what we *try*; the frozen row decides what everyone *gets*.
 *
 * Days are UTC. A local-time boundary would mean the "same" day covers
 * different songs depending on where you are standing, which is the exact
 * property this file is here to protect.
 */

const crypto = require('crypto');
const db = require('./db');
const { selectPacks, trackKey } = require('./packs');
const { resolveMany } = require('./itunes');

/** How many rounds a daily run is. */
const DAILY_ROUNDS = 5;

/**
 * The pack the daily is drawn from. All Time is the broadest thing in the
 * catalogue and is by construction the top slice of every decade, so its own
 * top end is about as widely known as recorded music gets.
 */
const DAILY_PACK = 'allTime';

/**
 * How deep into the pack a daily song can come from.
 *
 * The brief is "easy", and the honest way to get there is a hard cut rather
 * than difficulty.js's weighting. The slider is deliberately a preference that
 * never excludes anything (see the header of difficulty.js), which is right for
 * a room choosing its own mix and wrong here: a daily that occasionally reaches
 * into the long tail would hand one day's players a materially harder game than
 * the next day's, and there is no rematch to even it out. So the pool is the
 * pack's best-known 300 and nothing else -- ranked by popularity, which is what
 * the pack already arrives sorted by.
 */
const DAILY_POOL = 300;

/** Longest we will spend resolving previews while settling a day's songs. */
const DAILY_DEADLINE_MS = 25000;

/* -------------------------------------------------------------- the day */

/** The current UTC day, as 'YYYY-MM-DD'. */
function today(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/** When the current day rolls over, in ms since the epoch. */
function nextReset(now = Date.now()) {
  return Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate() + 1
  );
}

function isDayKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

/* ------------------------------------------------------------- the seed */

/**
 * A deterministic PRNG seeded from a day key.
 *
 * mulberry32, seeded from the first four bytes of a SHA-256 over the day and a
 * salt. The salt is only there so the schedule is not readable off the source:
 * without one, anybody could run this file and have tomorrow's songs. It is
 * optional -- unset simply means the sequence is public, which spoils the
 * surprise and nothing else.
 */
function seededRandom(day) {
  const salt = process.env.DAILY_SALT || '';
  const digest = crypto.createHash('sha256').update(`memorybeat|${salt}|${day}`).digest();
  let state = digest.readUInt32BE(0);
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The day's candidate songs, most-wanted first.
 *
 * A full Fisher-Yates over the pool rather than five draws: the resolver may
 * have to walk past a good many of these before it finds five it can play, and
 * the order it walks has to be as deterministic as the first five would be.
 */
function candidates(day) {
  const selection = selectPacks([DAILY_PACK]);
  if (!selection || !selection.tracks.length) return [];

  const pool = selection.tracks.slice(0, DAILY_POOL);
  const random = seededRandom(day);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

/* ------------------------------------------------------------ the freeze */

function readFrozen(day) {
  const row = db.open().prepare('SELECT tracks FROM daily_challenges WHERE day = ?').get(day);
  if (!row) return null;
  try {
    const tracks = JSON.parse(row.tracks);
    return Array.isArray(tracks) && tracks.length ? tracks : null;
  } catch {
    return null;
  }
}

function writeFrozen(day, tracks) {
  db.open()
    .prepare('INSERT INTO daily_challenges (day, tracks, created_at) VALUES (?, ?, ?)'
      + ' ON CONFLICT (day) DO NOTHING')
    .run(day, JSON.stringify(tracks), Date.now());
}

/**
 * Settling a day is slow (it can spend the better part of half a minute inside
 * iTunes) and several people can ask for it at once -- the first request after
 * a reset, and every request queued behind it. One promise per day means they
 * all wait on the same work rather than each starting their own walk of the
 * candidate list and racing to write different answers.
 */
const inFlight = new Map(); // day -> Promise<tracks>

/**
 * The day's five songs, resolved and ready to play.
 *
 * Returns tracks decorated with previewUrl/artwork, in the order they will be
 * played. The frozen row stores only the metadata: previews are re-resolved
 * from the (durable, on-disk) iTunes cache on the way out, so a restart costs
 * nothing and the row stays small.
 *
 * @returns {Promise<Array>} five playable tracks, or fewer if iTunes is having
 *          a bad day and the set has not been frozen yet
 */
function challenge(day = today()) {
  const existing = inFlight.get(day);
  if (existing) return existing;

  const job = build(day).finally(() => inFlight.delete(day));
  inFlight.set(day, job);
  return job;
}

async function build(day) {
  const frozen = readFrozen(day);
  if (frozen) {
    // Already settled. These resolved once, so they are in the iTunes cache and
    // this is almost always a no-network call; the deadline is a backstop for
    // the case where the cache file was lost.
    const playable = await resolveMany(frozen, {
      enough: frozen.length,
      deadlineMs: DAILY_DEADLINE_MS
    });
    // Order comes from the frozen row, not from what resolved first.
    const byKey = new Map(playable.map((t) => [trackKey(t), t]));
    return frozen.map((t) => byKey.get(trackKey(t))).filter(Boolean);
  }

  const pool = candidates(day);
  if (!pool.length) return [];

  const playable = await resolveMany(pool, {
    enough: DAILY_ROUNDS,
    deadlineMs: DAILY_DEADLINE_MS
  });
  const chosen = playable.slice(0, DAILY_ROUNDS);

  // A short set is never frozen. Freezing it would lock a bad day in for the
  // next twenty-four hours over what is almost always a transient rate limit;
  // better to hand this player what we have and let the next request try again.
  if (chosen.length >= DAILY_ROUNDS) {
    writeFrozen(day, chosen.map((t) => ({
      title: t.title,
      artist: t.artist,
      ...(t.query ? { query: t.query } : {}),
      ...(t.year != null ? { year: t.year } : {})
    })));
    // Two requests can settle the same day at once; the INSERT above is a
    // no-op for the loser, so it re-reads and plays the winner's set. Without
    // this the two players would get different songs -- the one thing that
    // must not happen.
    const settled = readFrozen(day);
    if (settled && !sameSet(settled, chosen)) return build(day);
  }

  return chosen;
}

function sameSet(a, b) {
  return a.length === b.length && a.every((t, i) => trackKey(t) === trackKey(b[i]));
}

/**
 * Settle today's songs ahead of anybody asking for them.
 *
 * Called on boot and just after each reset. Purely an optimisation -- the first
 * player of the day would do this anyway -- but doing it for them turns a
 * twenty-second cold start into an instant one.
 */
function warm() {
  challenge().then(
    (tracks) => {
      if (tracks.length >= DAILY_ROUNDS) console.log(`[daily] ${today()} ready (${tracks.length} songs)`);
      else console.warn(`[daily] ${today()} could only resolve ${tracks.length} songs; will retry on demand`);
    },
    (err) => console.warn('[daily] warm failed:', err.message)
  );
}

/* ------------------------------------------------------------------ runs */

/** Today's finished run for this account, or null. */
function runFor(day, discordId) {
  return db.open()
    .prepare('SELECT * FROM daily_runs WHERE day = ? AND discord_id = ?')
    .get(day, String(discordId)) || null;
}

/**
 * File a finished run.
 *
 * `INSERT ... ON CONFLICT DO NOTHING` is the whole one-run-a-day rule: the
 * first finish for an account on a day is kept and every later one is dropped
 * on the floor. Deliberately not an upsert -- "best score kept" would reward
 * replaying a game whose answers you now know.
 *
 * An abandoned run never reaches here at all, so it can be retried. That is the
 * intended tradeoff: it lets somebody who lost their connection start again,
 * at the cost of letting somebody quit a bad first round and re-roll the same
 * five songs.
 *
 * @returns {boolean} true if this run was the one recorded
 */
function recordRun(day, user, stats) {
  const info = db.open()
    .prepare(`INSERT INTO daily_runs
                (day, discord_id, username, avatar, score, correct, rounds, total_ms, best_ms, finished_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (day, discord_id) DO NOTHING`)
    .run(
      day,
      String(user.id),
      String(user.username || 'Player').slice(0, 32),
      user.avatar || null,
      Math.max(0, Math.round(stats.score) || 0),
      Math.max(0, Math.round(stats.correct) || 0),
      Math.max(0, Math.round(stats.rounds) || 0),
      stats.totalMs == null ? null : Math.round(stats.totalMs),
      stats.bestMs == null ? null : Math.round(stats.bestMs),
      Date.now()
    );
  return info.changes > 0;
}

/* ---------------------------------------------------------- leaderboards */

const BOARD_LIMIT = 100;

/**
 * Ties break on who finished first.
 *
 * Score already encodes speed to the millisecond (game.js pays out on elapsed
 * time), so an exact tie means two people were within a millisecond of each
 * other on all five songs and any tiebreak is arbitrary. Finish order is at
 * least a fact rather than a computation.
 */
function todayBoard(day, limit = BOARD_LIMIT) {
  return db.open()
    .prepare(`SELECT discord_id, username, avatar, score, correct, rounds, best_ms, finished_at
                FROM daily_runs
               WHERE day = ?
               ORDER BY score DESC, finished_at ASC
               LIMIT ?`)
    .all(day, limit)
    .map(toEntry);
}

/**
 * Every run ever, per account.
 *
 * Total score rather than average, so the board rewards turning up. An average
 * would put somebody who played once and got lucky above somebody who has
 * played every day since launch, which is not what an all-time board is for.
 */
function allTimeBoard(limit = BOARD_LIMIT) {
  return db.open()
    .prepare(`SELECT discord_id,
                     username,
                     avatar,
                     SUM(score)   AS score,
                     SUM(correct) AS correct,
                     SUM(rounds)  AS rounds,
                     COUNT(*)     AS days,
                     MAX(score)   AS best,
                     MIN(best_ms) AS best_ms,
                     MAX(finished_at) AS finished_at
                FROM daily_runs
               GROUP BY discord_id
               ORDER BY score DESC, days DESC, finished_at ASC
               LIMIT ?`)
    .all(limit)
    .map((row) => ({ ...toEntry(row), days: row.days, best: row.best }));
}

/**
 * Where an account sits on a board it may be too far down to appear on.
 *
 * Counting the rows above someone is cheap on the daily board (the index is in
 * exactly that order) and it means the client can always show "you", even at
 * rank 4,000, without shipping four thousand rows to find out.
 */
function todayRank(day, discordId) {
  const mine = runFor(day, discordId);
  if (!mine) return null;
  const { above } = db.open()
    .prepare(`SELECT COUNT(*) AS above
                FROM daily_runs
               WHERE day = ?
                 AND (score > ? OR (score = ? AND finished_at < ?))`)
    .get(day, mine.score, mine.score, mine.finished_at);
  const { total } = db.open()
    .prepare('SELECT COUNT(*) AS total FROM daily_runs WHERE day = ?')
    .get(day);
  return { rank: above + 1, of: total, ...toEntry(mine) };
}

function toEntry(row) {
  return {
    id: row.discord_id,
    name: row.username,
    // The raw hash is stored; the CDN URL is built on the way out so a change
    // of size or format does not need a migration.
    avatar: row.avatar
      ? `https://cdn.discordapp.com/avatars/${row.discord_id}/${row.avatar}`
        + `.${String(row.avatar).startsWith('a_') ? 'gif' : 'png'}?size=64`
      : null,
    score: row.score,
    correct: row.correct,
    rounds: row.rounds,
    bestMs: row.best_ms,
    at: row.finished_at
  };
}

module.exports = {
  DAILY_ROUNDS,
  DAILY_PACK,
  DAILY_POOL,
  today,
  nextReset,
  isDayKey,
  candidates,
  challenge,
  warm,
  runFor,
  recordRun,
  todayBoard,
  allTimeBoard,
  todayRank
};
