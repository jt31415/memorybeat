'use strict';

/**
 * Resolves pack tracks to iTunes 30-second preview clips, and serves that
 * audio back out through our own origin.
 *
 * Two reasons the audio is proxied instead of linked directly:
 *   1. The iTunes preview URL leaks the song title, and a curious player with
 *      devtools open would just read the answer off the network tab.
 *   2. Same-origin audio can be piped into the Web Audio API, which is what
 *      the visualiser needs.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { searchTerm, trackKey } = require('./packs');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'itunes-cache.json');
const SEARCH_URL = 'https://itunes.apple.com/search';

// Recordings that are technically a match but would ruin the round.
const BAD_VERSION = /karaoke|tribute|made famous|originally performed|as made popular|instrumental|8[- ]bit|lullaby|workout mix|in the style of|sped up|slowed|cover version|\bcovers?\b/i;

/* ------------------------------------------------------------------ cache */

let cache = {};
try {
  cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
} catch {
  cache = {};
}

let saveTimer = null;
function saveCache() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
    } catch (err) {
      console.warn('[itunes] could not write cache:', err.message);
    }
  }, 1000);
  saveTimer.unref?.();
}

/* ---------------------------------------------------------------- matching */

function normalise(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\bfeat\b.*$|\bft\b.*$|\bwith\b.*$/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function primaryArtist(artist) {
  return normalise(String(artist).split(/,| & | and |feat\.|ft\.|vs\.|x /i)[0]);
}

function scoreCandidate(candidate, track) {
  const haystack = `${candidate.trackName} ${candidate.collectionName || ''} ${candidate.artistName}`;
  if (BAD_VERSION.test(haystack)) return -1;
  if (!candidate.previewUrl) return -1;

  const wantTitle = normalise(track.title);
  const gotTitle = normalise(candidate.trackName);
  const wantArtist = primaryArtist(track.artist);
  const gotArtist = normalise(candidate.artistName);

  let score = 0;
  if (gotTitle === wantTitle) score += 60;
  else if (gotTitle.startsWith(wantTitle) || wantTitle.startsWith(gotTitle)) score += 40;
  else if (gotTitle.includes(wantTitle)) score += 20;
  else return -1; // wrong song entirely

  if (gotArtist === wantArtist) score += 40;
  else if (gotArtist.includes(wantArtist) || wantArtist.includes(gotArtist)) score += 30;
  else score -= 25;

  // Prefer the original studio cut over live/remix/edit re-releases.
  if (/live|remix|edit|version|mix/i.test(candidate.trackName) && !/remix|version|mix/i.test(track.title)) {
    score -= 15;
  }
  if (candidate.trackExplicitness === 'explicit') score += 1; // usually the charting cut
  return score;
}

/* --------------------------------------------------------------- resolving */

// iTunes throttles hard if you fire off lookups in parallel: first 429s, then
// a stretch of 403s for the whole IP. So every search goes through a single
// queue with a minimum gap, and a throttle response pauses the whole queue.
const DEFAULT_SEARCH_GAP_MS = 350;
const MAX_COOLDOWN_MS = 60000;

let searchGap = DEFAULT_SEARCH_GAP_MS;
let searchChain = Promise.resolve();
let lastSearch = 0;
let blockedUntil = 0;
let cooldown = 2000;
// Throttles in a row with no clean response in between. A handful means we hit
// a rate limit; a long run means Apple has blocked the IP outright and there is
// no point waiting it out inside this process.
let throttleStreak = 0;
let aborted = false;
// Streak at which the queue stops trying at all. Off by default: the game has
// its own deadline and must stay usable, so only bulk jobs opt in.
let throttleGiveUp = Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True once we are done waiting on Apple, one way or another. */
function givenUp() {
  return aborted || throttleStreak >= throttleGiveUp;
}

/** Sleep, but in slices, so giving up mid-cooldown is noticed promptly. */
async function sleepInterruptible(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (givenUp()) return;
    await sleep(Math.min(1000, until - Date.now()));
  }
}

/** Called when Apple pushes back -- everything queued behind this waits. */
function backOff(retryAfterHeader) {
  const header = Number(retryAfterHeader) * 1000;
  const waitMs = Number.isFinite(header) && header > 0 ? header : cooldown;
  blockedUntil = Math.max(blockedUntil, Date.now() + waitMs);
  cooldown = Math.min(cooldown * 2, MAX_COOLDOWN_MS);
  throttleStreak++;
  return waitMs;
}

/** Minimum spacing between searches. Bulk jobs should ask for a wider gap. */
function setSearchGap(ms) {
  searchGap = Math.max(0, Number(ms) || 0);
}

/**
 * Stop waiting on Apple once `n` throttles have come back in a row. This is a
 * one-way trip -- nothing can produce the clean response that resets the streak
 * -- so call resumeSearches() to lift it. Bulk jobs want this; the game does
 * not, since it must keep working for the next room.
 */
function setThrottleGiveUp(n) {
  throttleGiveUp = Number(n) > 0 ? Number(n) : Infinity;
}

/** Lets a caller decide the queue is hopeless rather than grinding on. */
function searchHealth() {
  return {
    throttleStreak,
    blockedMs: Math.max(0, blockedUntil - Date.now()),
    givenUp: givenUp()
  };
}

/**
 * Make every queued and future search fail immediately instead of sitting in
 * cooldown. Used by bulk jobs that would rather stop than stall for hours.
 */
function abortSearches() {
  aborted = true;
}

function resumeSearches() {
  aborted = false;
  throttleGiveUp = Infinity;
  blockedUntil = 0;
  cooldown = 2000;
  throttleStreak = 0;
}

function schedule(fn) {
  const run = searchChain.then(async () => {
    // Bailing out here rather than in the retry loop is what makes a hard block
    // cheap: it kills the remaining attempts for the current track too, not
    // just the tracks after it.
    if (givenUp()) throw Object.assign(new Error('searches given up'), { status: 503 });
    const blocked = blockedUntil - Date.now();
    if (blocked > 0) await sleepInterruptible(blocked);
    if (givenUp()) throw Object.assign(new Error('searches given up'), { status: 503 });
    const gap = searchGap - (Date.now() - lastSearch);
    if (gap > 0) await sleep(gap);
    lastSearch = Date.now();
    return fn();
  });
  // Keep the chain alive even when a link rejects.
  searchChain = run.then(() => {}, () => {});
  return run;
}

async function searchOnce(term) {
  const url = `${SEARCH_URL}?term=${encodeURIComponent(term)}&entity=song&limit=15&country=US`;
  const res = await fetch(url, { headers: { 'User-Agent': 'memorybeat/1.0' } });
  if (!res.ok) {
    const err = new Error(`iTunes search HTTP ${res.status}`);
    err.status = res.status;
    err.retryAfter = res.headers.get('retry-after');
    throw err;
  }
  const body = await res.json();
  cooldown = 2000; // a clean response means we are back in Apple's good books
  throttleStreak = 0;
  return Array.isArray(body.results) ? body.results : [];
}

async function searchItunes(term) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await schedule(() => searchOnce(term));
    } catch (err) {
      lastErr = err;
      const throttled = err.status === 429 || err.status === 403;
      if (!throttled && err.status) throw err;
      if (throttled) backOff(err.retryAfter);
      else await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * @returns {Promise<{previewUrl:string, artwork:string}|null>}
 */
async function resolveTrack(track) {
  const key = trackKey(track);
  const hit = cache[key];
  if (hit) return hit.previewUrl ? hit : null;

  let best = null;
  let bestScore = 0;
  try {
    const results = await searchItunes(searchTerm(track));
    for (const candidate of results) {
      const score = scoreCandidate(candidate, track);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
  } catch (err) {
    console.warn(`[itunes] lookup failed for "${track.title}":`, err.message);
    return null; // transient -- do not poison the cache
  }

  if (!best) {
    cache[key] = { previewUrl: null, at: Date.now() };
    saveCache();
    return null;
  }

  const entry = {
    previewUrl: best.previewUrl,
    artwork: (best.artworkUrl100 || '').replace(/100x100bb/, '400x400bb'),
    at: Date.now()
  };
  cache[key] = entry;
  saveCache();
  return entry;
}

/** Whatever the cache already knows, with no network call. */
function resolveCached(track) {
  const hit = cache[trackKey(track)];
  return hit && hit.previewUrl ? hit : null;
}

/**
 * Resolve as many tracks as possible, cheapest first.
 *
 * Cached tracks come back instantly; the rest are looked up over the network
 * until `enough` of them are in hand or `deadlineMs` passes. Apple can throttle
 * us for minutes at a time, and nobody should stare at a loading screen that
 * long -- we play with the songs we have.
 *
 * `avoid` is a set of trackKeys the caller would rather not use (recently
 * played ones). They are still resolved and returned as a fallback, but they do
 * not count towards `enough` -- otherwise a barely-warm cache would satisfy the
 * quota with the same handful of songs every game and never look anything new
 * up. `tracks` order decides priority, so put the wanted ones first.
 *
 * @returns {Promise<Array>} tracks decorated with previewUrl/artwork
 */
async function resolveMany(tracks, opts = {}) {
  const { concurrency = 4, deadlineMs = 15000, enough = tracks.length, avoid = null } = opts;
  const out = new Array(tracks.length).fill(null);
  const pending = [];
  const wanted = (i) => !avoid || !avoid.has(trackKey(tracks[i]));

  tracks.forEach((track, i) => {
    const hit = resolveCached(track);
    if (hit) out[i] = hit;
    else pending.push(i);
  });

  let found = out.reduce((n, hit, i) => (hit && wanted(i) ? n + 1 : n), 0);
  const expiry = Date.now() + deadlineMs;

  if (found < enough && pending.length) {
    let next = 0;
    const worker = async () => {
      while (next < pending.length && found < enough && Date.now() < expiry) {
        const i = pending[next++];
        const hit = await resolveTrack(tracks[i]);
        if (hit) {
          out[i] = hit;
          if (wanted(i)) found++;
        }
      }
    };
    const pool = Promise.all(
      Array.from({ length: Math.min(concurrency, pending.length) }, worker)
    );
    // A single lookup can sit in a long retry backoff, so the deadline has to
    // cap the whole phase rather than just the decision to start another one.
    // Abandoned lookups keep running and populate the cache for next time.
    let timer;
    await Promise.race([
      pool,
      new Promise((r) => {
        timer = setTimeout(r, Math.max(0, expiry - Date.now()));
        timer.unref?.();
      })
    ]);
    clearTimeout(timer);
    pool.catch(() => {}); // nothing is waiting on it any more
  }

  return tracks
    .map((track, i) => (out[i] ? { ...track, ...out[i] } : null))
    .filter(Boolean);
}

/* ------------------------------------------------------- audio token store */

const tokens = new Map(); // token -> { url, expires }
const TOKEN_TTL = 60 * 60 * 1000;

function mintToken(previewUrl) {
  const token = crypto.randomBytes(12).toString('hex');
  tokens.set(token, { url: previewUrl, expires: Date.now() + TOKEN_TTL });
  return token;
}

function urlForToken(token) {
  const entry = tokens.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    tokens.delete(token);
    return null;
  }
  return entry.url;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokens) if (entry.expires < now) tokens.delete(token);
}, 10 * 60 * 1000).unref();

/* ------------------------------------------------------------ audio bytes */

const clips = new Map(); // previewUrl -> Buffer (bounded, LRU-ish)
const CLIP_LIMIT = 80;
const inflight = new Map();

async function fetchClip(previewUrl) {
  const cached = clips.get(previewUrl);
  if (cached) {
    clips.delete(previewUrl); // refresh recency
    clips.set(previewUrl, cached);
    return cached;
  }
  if (inflight.has(previewUrl)) return inflight.get(previewUrl);

  const job = (async () => {
    const res = await fetch(previewUrl, { headers: { 'User-Agent': 'memorybeat/1.0' } });
    if (!res.ok) throw new Error(`preview HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    clips.set(previewUrl, buf);
    while (clips.size > CLIP_LIMIT) clips.delete(clips.keys().next().value);
    return buf;
  })();

  inflight.set(previewUrl, job);
  try {
    return await job;
  } finally {
    inflight.delete(previewUrl);
  }
}

/** Pull clips into memory ahead of time so round starts are instant. */
function prefetch(previewUrls) {
  for (const url of previewUrls) {
    fetchClip(url).catch(() => {});
  }
}

module.exports = {
  resolveTrack,
  resolveCached,
  resolveMany,
  mintToken,
  urlForToken,
  fetchClip,
  prefetch,
  setSearchGap,
  setThrottleGiveUp,
  searchHealth,
  abortSearches,
  resumeSearches
};
