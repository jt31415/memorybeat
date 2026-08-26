'use strict';

/**
 * Deezer playlist import.
 *
 * The default source, for one reason that outranks everything else: it needs no
 * credentials. No app registration, no client secret, no subscription, no quota
 * mode -- the public API answers an unauthenticated GET. Spotify's equivalent
 * requires a registered app that, for anything short of a 250k-user company, is
 * permanently stuck in development mode and obliges the app owner to hold
 * Premium (see spotify.js).
 *
 * We take metadata only. Deezer's own 30-second `preview` URL is ignored, and
 * so is `readable` -- that flag is about Deezer's regional licensing, and the
 * audio we actually play comes from iTunes (see itunes.js), which has its own
 * catalogue and its own gaps. A track Deezer will not stream to us is very often
 * one Apple will.
 */

const { cleanTitle, cleanArtist } = require('./titles');

const API = 'https://api.deezer.com';

/** Tracks per request. Deezer caps a page at 100 and we may as well ask for it. */
const PAGE = 100;

/**
 * Hard ceiling on an imported playlist.
 *
 * Not a Deezer limit -- a limit on us. Every track is a row we hold in memory
 * and a candidate the resolver may walk, and a game needs ten songs. Somebody's
 * 8,000-track "everything" playlist is not a better game than its first 1,000,
 * it is just more work; the client is told when this bites.
 */
const MAX_TRACKS = 1000;

/**
 * Deezer's documented budget is 50 requests per 5 seconds per IP. A full
 * MAX_TRACKS import is ten requests, so this gap is nowhere near necessary --
 * it is here so that several people importing at once still cannot trip it.
 */
const GAP_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A Deezer playlist id out of whatever the user pasted.
 *
 * Accepts the share URL in its various shapes (the locale segment is optional
 * and arbitrary: /playlist/, /en/playlist/, /us/playlist/), and a bare numeric
 * id, which is what someone reading an id out of a URL by hand tends to send.
 */
const URL_PATTERNS = [
  /(?:deezer\.com|deezer\.page\.link)\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?playlist\/(\d+)/i,
  /^playlist\/(\d+)$/i,
  /^(\d{6,})$/
];

/** Shortlinks carry no id, so the id has to come from where they land. */
const SHORTLINK = /^https?:\/\/(?:deezer\.page\.link|link\.deezer\.com)\//i;

function matchId(input) {
  const text = String(input || '').trim();
  for (const pattern of URL_PATTERNS) {
    const hit = pattern.exec(text);
    if (hit) return hit[1];
  }
  return null;
}

/**
 * True when this adapter recognises the input at all -- including a shortlink,
 * whose id is only knowable after a round trip (see resolveId).
 */
function match(input) {
  const text = String(input || '').trim();
  return Boolean(matchId(text)) || SHORTLINK.test(text);
}

/**
 * The playlist id, following a shortlink if that is what we were given.
 *
 * Deliberately only a redirect follow. If Deezer answers a shortlink with an
 * interstitial page rather than a Location header there is no id to be had, and
 * we say so rather than start scraping HTML for one -- a parser aimed at a page
 * we do not control is a maintenance burden that breaks silently and at the
 * worst moment.
 */
async function resolveId(input) {
  const direct = matchId(input);
  if (direct) return direct;

  const text = String(input || '').trim();
  if (!SHORTLINK.test(text)) return null;

  let res;
  try {
    res = await fetch(text, {
      redirect: 'follow',
      headers: { 'User-Agent': 'memorybeat/1.0' }
    });
  } catch {
    return null;
  }
  return matchId(res.url);
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'memorybeat/1.0' } });
  if (!res.ok) {
    throw Object.assign(new Error(`Deezer HTTP ${res.status}`), { status: res.status });
  }
  const body = await res.json();
  // Deezer reports failure in a 200 body rather than a status code, so this is
  // the only place a bad id or a private playlist actually shows up.
  if (body && body.error) {
    const code = Number(body.error.code);
    // Deezer's own wording is for developers ("no data"), and this string goes
    // straight to somebody who just pasted a link -- so 800, the only code they
    // can actually act on, gets told what to do about it.
    const message = code === 800
      ? 'Deezer has no such playlist. Check the link, and note that private '
        + 'playlists cannot be imported -- it has to be public.'
      : `Deezer error: ${body.error.message || code}`;
    throw Object.assign(new Error(message), {
      status: code === 800 ? 404 : 502,
      deezerCode: code
    });
  }
  return body;
}

/**
 * One track, as the rest of the app wants it.
 *
 * `title_short` is the win here: Deezer publishes the title already stripped of
 * its version suffix, and does it better than any regex we could write -- it
 * turns "Hey Jude (Remastered 2015)" into "Hey Jude" while leaving the leading
 * parenthetical of "(I Can't Get No) Satisfaction" alone. titles.cleanTitle() is
 * only the fallback for the rare row that has no short form.
 *
 * `rank` becomes `popularity` purely so choice mode can draw fame-matched
 * decoys: pickDecoys() windows the pack by position, and a pack ordered by
 * popularity is what stops a household name being sat next to three
 * obscurities. It does *not* make the pool unevenly weighted -- an imported
 * playlist is flagged equalWeight, so song choice ignores popularity entirely
 * (see playlists/index.js and difficulty.js).
 */
function toTrack(row) {
  const title = cleanTitle(row.title_short || row.title);
  const artist = cleanArtist(row.artist && row.artist.name);
  if (!title || !artist) return null;

  const track = { title, artist };
  // Deezer's rank runs to about 10^6. Only the ordering is ever read, so a
  // plain scale into the 0..100 the rest of the app uses is enough.
  const rank = Number(row.rank);
  if (Number.isFinite(rank) && rank > 0) {
    track.popularity = Math.max(0, Math.min(100, rank / 10000));
  }
  return track;
}

/**
 * @param {string} input a Deezer playlist URL, "playlist/<id>", or a bare id
 * @returns {Promise<{name:string, tracks:Array, truncated:boolean, url:string}>}
 */
async function fetchPlaylist(input) {
  const id = await resolveId(input);
  if (!id) throw Object.assign(new Error('Not a Deezer playlist link.'), { status: 400 });

  const meta = await getJson(`${API}/playlist/${id}`);

  const tracks = [];
  let truncated = false;
  // Paged through the dedicated tracks endpoint rather than read off the nested
  // `tracks.data` of the playlist body: the nested copy is capped, so a long
  // playlist would import as its first page and look complete.
  for (let index = 0; index < MAX_TRACKS; index += PAGE) {
    const page = await getJson(`${API}/playlist/${id}/tracks?index=${index}&limit=${PAGE}`);
    const rows = Array.isArray(page.data) ? page.data : [];
    for (const row of rows) {
      const track = toTrack(row);
      if (track) tracks.push(track);
    }
    if (rows.length < PAGE) break;
    if (index + PAGE >= MAX_TRACKS) {
      truncated = Number(page.total) > MAX_TRACKS;
      break;
    }
    await sleep(GAP_MS);
  }

  return {
    name: String(meta.title || 'Deezer playlist').slice(0, 80),
    tracks,
    truncated,
    url: `https://www.deezer.com/playlist/${id}`
  };
}

module.exports = {
  id: 'deezer',
  label: 'Deezer',
  /** No credentials, ever -- so this adapter is never unavailable. */
  available: () => true,
  unavailableReason: () => '',
  match,
  fetchPlaylist,
  MAX_TRACKS
};
