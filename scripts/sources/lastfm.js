'use strict';

/**
 * Last.fm: genre pack contents, and the listener counts used to rank songs.
 *
 * Needs a free API key (last.fm/api/account/create), passed as LASTFM_API_KEY.
 * Everything here degrades to "unavailable" without one rather than throwing, so
 * the decade packs can still be built on their own.
 *
 * Two endpoints:
 *   tag.getTopTracks  -- what belongs in a genre pack, in popularity order
 *   track.getInfo     -- listeners / playcount for one track
 *
 * Requests go through a single queue with a fixed gap. Last.fm's published limit
 * is roughly 5 requests/second/key averaged over time; we sit well under it
 * because a pack build is a background job and getting the key throttled would
 * cost far more than the extra minutes.
 */

const API = 'https://ws.audioscrobbler.com/2.0/';
const UA = 'memorybeat/1.0 (pack builder)';
const GAP_MS = 220;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apiKey() {
  return process.env.LASTFM_API_KEY || '';
}

function available() {
  return Boolean(apiKey());
}

let chain = Promise.resolve();
let last = 0;

function schedule(fn) {
  const run = chain.then(async () => {
    const wait = GAP_MS - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    last = Date.now();
    return fn();
  });
  chain = run.then(() => {}, () => {});
  return run;
}

async function callOnce(method, params) {
  const query = new URLSearchParams({
    method,
    api_key: apiKey(),
    format: 'json',
    ...params
  });
  const res = await fetch(`${API}?${query}`, { headers: { 'User-Agent': UA } });

  // 429 and the 5xx range are worth retrying; a bad key or a missing track is not.
  if (res.status === 429 || res.status >= 500) {
    const err = new Error(`Last.fm HTTP ${res.status}`);
    err.retryable = true;
    throw err;
  }
  // An unparseable body is a transient upstream glitch (a gateway error page, a
  // truncated response), not a fact about the track -- so it is worth retrying
  // rather than treating as fatal.
  const body = await res.json().catch(() => null);
  if (!body) {
    const err = new Error('Last.fm returned no JSON');
    err.retryable = true;
    throw err;
  }
  if (body.error) {
    // 6 = "not found", which for track.getInfo is an ordinary outcome.
    const err = new Error(`Last.fm error ${body.error}: ${body.message}`);
    err.code = body.error;
    err.retryable = body.error === 8 || body.error === 16 || body.error === 29;
    throw err;
  }
  return body;
}

async function call(method, params) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await schedule(() => callOnce(method, params));
    } catch (err) {
      lastErr = err;
      if (!err.retryable) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * Top tracks for a tag, in Last.fm's own popularity order.
 *
 * The API pages at 1000 max but realistically returns useful results only for
 * the first few hundred of a tag, so callers ask for what they need.
 *
 * @returns {Promise<Array<{rank:number,title:string,artist:string}>>}
 */
async function tagTopTracks(tag, limit = 200) {
  const out = [];
  const perPage = Math.min(1000, limit);
  for (let page = 1; out.length < limit; page++) {
    const body = await call('tag.gettoptracks', {
      tag,
      limit: String(perPage),
      page: String(page)
    });
    const tracks = body.tracks && body.tracks.track;
    const list = Array.isArray(tracks) ? tracks : tracks ? [tracks] : [];
    if (!list.length) break;

    for (const t of list) {
      const title = String(t.name || '').trim();
      const artist = String((t.artist && t.artist.name) || '').trim();
      if (!title || !artist) continue;
      out.push({ rank: out.length + 1, title, artist });
      if (out.length >= limit) break;
    }
    // Short page means we have reached the end of the tag.
    if (list.length < perPage) break;
  }
  return out;
}

const loose = (s) => String(s || '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '');

/**
 * Listener and play counts for one track.
 *
 * `listeners` is the number of distinct people who have ever played it, which is
 * the signal we actually want: it tracks how widely *known* a song is. playcount
 * is dominated by how obsessively a smaller group replays it.
 *
 * Pass the LEAD artist, not a full credit line -- see packs.leadArtist().
 *
 * The response is checked against what was asked for, because `autocorrect=1`
 * does not only fix typos: handed something it cannot place, it will silently
 * return a *different* artist's obscure track complete with a small, entirely
 * believable listener count. An unverified answer here is worse than no answer,
 * since it ranks a megahit at the bottom of the catalogue.
 *
 * @returns {Promise<{listeners:number,playcount:number}|null>} null when unknown
 */
async function trackInfo(title, artist) {
  let body;
  try {
    body = await call('track.getinfo', { track: title, artist, autocorrect: '1' });
  } catch (err) {
    if (err.code === 6) return null; // no such track, an ordinary outcome
    throw err;
  }
  const t = body.track;
  if (!t) return null;

  const gotArtist = loose(t.artist && t.artist.name);
  const wantArtist = loose(artist);
  if (gotArtist && wantArtist && !gotArtist.includes(wantArtist) && !wantArtist.includes(gotArtist)) {
    return null; // autocorrect wandered off; treat as unknown
  }

  const listeners = parseInt(t.listeners, 10);
  const playcount = parseInt(t.playcount, 10);
  if (!Number.isFinite(listeners) && !Number.isFinite(playcount)) return null;
  return {
    listeners: Number.isFinite(listeners) ? listeners : 0,
    playcount: Number.isFinite(playcount) ? playcount : 0
  };
}

module.exports = { available, tagTopTracks, trackInfo };
