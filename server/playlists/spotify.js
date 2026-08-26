'use strict';

/**
 * Spotify playlist import. Complete, and switched off unless credentials exist.
 *
 * ## Read this before setting the credentials
 *
 * Spotify does not issue a single API key. It issues a **client id and a client
 * secret**, both 32 hex characters, from developer.spotify.com/dashboard. A lone
 * opaque token -- whatever its prefix -- is not a Spotify credential and will
 * come back 401 / invalid_client.
 *
 * Two limits then apply, and neither is something this code can work around:
 *
 *  1. A new app sits in **development mode**, and Spotify's quota-modes page
 *     states the app owner must hold Spotify Premium for a development-mode app
 *     to function. Leaving development mode requires extended quota mode, which
 *     since May 2025 is open only to organisations with 250k+ monthly actives.
 *     A hobby deployment stays in development mode permanently.
 *  2. Since November 2024, **Spotify-owned editorial and algorithmic playlists**
 *     -- Today's Top Hits, Discover Weekly, Release Radar -- return 404 to
 *     client-credentials apps. User-created playlists are unaffected. A 404 here
 *     is therefore far more likely to be that than a typo, which is why the
 *     error says so.
 *
 * Deezer has none of this and is the default (see deezer.js). This adapter is
 * kept because it costs nothing to keep, and because the shape of the thing --
 * URL in, {title, artist} out -- is the whole point of the adapter split.
 */

const env = require('../env');
const { cleanTitle, cleanArtist } = require('./titles');

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';

const PAGE = 100;             // Spotify's maximum page size for playlist items
const MAX_TRACKS = 1000;      // our ceiling, matching deezer.js

/** Playlist ids are 22-character base62. */
const URL_PATTERNS = [
  /open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/([A-Za-z0-9]{22})/i,
  /^spotify:playlist:([A-Za-z0-9]{22})$/i,
  /^([A-Za-z0-9]{22})$/
];

function credentials() {
  return {
    id: env.get('SPOTIFY_CLIENT_ID'),
    secret: env.get('SPOTIFY_CLIENT_SECRET')
  };
}

function available() {
  const { id, secret } = credentials();
  return Boolean(id && secret);
}

function unavailableReason() {
  if (available()) return '';
  const { id, secret } = credentials();
  if (id && !secret) return 'SPOTIFY_CLIENT_SECRET is not set.';
  if (!id && secret) return 'SPOTIFY_CLIENT_ID is not set.';
  return 'Spotify import needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.';
}

function match(input) {
  const text = String(input || '').trim();
  return URL_PATTERNS.some((pattern) => pattern.test(text));
}

function matchId(input) {
  const text = String(input || '').trim();
  for (const pattern of URL_PATTERNS) {
    const hit = pattern.exec(text);
    if (hit) return hit[1];
  }
  return null;
}

/* ----------------------------------------------------------------- token */

// App tokens last an hour. Cached with a minute of headroom so a long import
// cannot have one expire underneath it mid-page.
let token = null;
let tokenExpires = 0;
let inflight = null;

async function requestToken() {
  const { id, secret } = credentials();
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // invalid_client is the one worth naming: it means the id/secret pair is
    // wrong, which is a configuration problem no retry will fix.
    const detail = body.error === 'invalid_client'
      ? 'Spotify rejected the client id/secret pair.'
      : body.error_description || `token HTTP ${res.status}`;
    throw Object.assign(new Error(detail), { status: 502 });
  }

  token = body.access_token;
  tokenExpires = Date.now() + Math.max(0, (Number(body.expires_in) || 3600) - 60) * 1000;
  return token;
}

async function accessToken() {
  if (token && Date.now() < tokenExpires) return token;
  // Collapse concurrent imports onto one token request rather than racing.
  if (!inflight) {
    inflight = requestToken().finally(() => { inflight = null; });
  }
  return inflight;
}

/* ---------------------------------------------------------------- fetching */

async function getJson(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'User-Agent': 'memorybeat/1.0'
    }
  });

  if (res.status === 401) {
    // Token rejected mid-import: drop it and let the caller retry once.
    token = null;
    tokenExpires = 0;
    throw Object.assign(new Error('Spotify token rejected.'), { status: 401 });
  }
  if (res.status === 404) {
    throw Object.assign(new Error(
      'Spotify returned 404. Editorial and algorithmic playlists (Today\'s Top '
      + 'Hits, Discover Weekly, Release Radar) are not readable by apps -- try a '
      + 'user-created playlist.'
    ), { status: 404 });
  }
  if (res.status === 429) {
    throw Object.assign(new Error('Spotify is rate limiting this app.'), { status: 429 });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`Spotify HTTP ${res.status}`), { status: 502 });
  }
  return res.json();
}

/**
 * `items[].track` is not always a track: a removed song comes back null, and a
 * podcast episode in a mixed playlist comes back with type 'episode' and no
 * usable artist. Both are skipped rather than imported as blanks.
 */
function toTrack(item) {
  const t = item && item.track;
  if (!t || t.type === 'episode' || !t.name) return null;

  const artists = Array.isArray(t.artists) ? t.artists.map((a) => a.name).filter(Boolean) : [];
  const title = cleanTitle(t.name);
  const artist = cleanArtist(artists.join(', '));
  if (!title || !artist) return null;

  const track = { title, artist };
  // Spotify's popularity is already 0..100. As with Deezer it is kept only so
  // choice mode can draw fame-matched decoys -- song choice stays uniform.
  if (Number.isFinite(Number(t.popularity))) {
    track.popularity = Math.max(0, Math.min(100, Number(t.popularity)));
  }
  return track;
}

async function fetchPlaylist(input) {
  if (!available()) throw Object.assign(new Error(unavailableReason()), { status: 501 });

  const id = matchId(input);
  if (!id) throw Object.assign(new Error('Not a Spotify playlist link.'), { status: 400 });

  const meta = await getJson(`${API}/playlists/${id}?fields=name`);

  const tracks = [];
  let truncated = false;
  // `fields` keeps the payload to what we read. A 1,000-track playlist is ten
  // pages, and the full item objects are enormous by comparison.
  const fields = 'items(track(name,type,popularity,artists(name))),total';

  for (let offset = 0; offset < MAX_TRACKS; offset += PAGE) {
    const page = await getJson(
      `${API}/playlists/${id}/tracks?limit=${PAGE}&offset=${offset}&fields=${encodeURIComponent(fields)}`
    );
    const items = Array.isArray(page.items) ? page.items : [];
    for (const item of items) {
      const track = toTrack(item);
      if (track) tracks.push(track);
    }
    if (items.length < PAGE) break;
    if (offset + PAGE >= MAX_TRACKS) {
      truncated = Number(page.total) > MAX_TRACKS;
      break;
    }
  }

  return {
    name: String(meta.name || 'Spotify playlist').slice(0, 80),
    tracks,
    truncated,
    url: `https://open.spotify.com/playlist/${id}`
  };
}

module.exports = {
  id: 'spotify',
  label: 'Spotify',
  available,
  unavailableReason,
  match,
  fetchPlaylist,
  MAX_TRACKS
};
