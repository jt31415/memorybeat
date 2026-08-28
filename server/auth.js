'use strict';

/**
 * Discord sign-in, for the daily challenge.
 *
 * The daily challenge has a global leaderboard and one attempt per person per
 * day, and neither of those means anything without an identity that costs
 * something to make. Everywhere else in MemoryBeat a player is a random string
 * in localStorage, which is exactly right for a room you were sent a link to
 * and exactly useless here -- clearing it would buy you another attempt, and a
 * script could mint a thousand of them. A Discord account is not
 * unforgeable, but it is enough friction to make a leaderboard worth reading.
 *
 * OAuth2 authorization-code flow with the `identify` scope: we learn an account
 * id, a display name and an avatar hash, and nothing else. The access token is
 * used once, on the callback, and then thrown away -- we never need to talk to
 * Discord on the player's behalf again, so there is nothing worth storing and
 * no refresh token is requested.
 *
 * Sessions are a signed cookie rather than rows in a table. The whole session
 * is (id, name, avatar, expiry), it is small, and it is only ever read -- so
 * there is nothing a server-side store would buy except a table to prune.
 */

const crypto = require('crypto');
const env = require('./env');
const db = require('./db');

const SESSION_COOKIE = 'mb_session';
const STATE_COOKIE = 'mb_oauth';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_MS = 10 * 60 * 1000;

const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';
const DISCORD_TOKEN = 'https://discord.com/api/oauth2/token';
const DISCORD_USER = 'https://discord.com/api/users/@me';

/* ---------------------------------------------------------------- config */

function clientId() {
  return env.get('DISCORD_CLIENT_ID');
}

function clientSecret() {
  return env.get('DISCORD_CLIENT_SECRET');
}

/**
 * Whether this deployment can sign anyone in at all. Checked before the daily
 * challenge offers itself, so a server without credentials says so plainly
 * instead of bouncing people to a Discord error page.
 */
function configured() {
  return !!(clientId() && clientSecret());
}

/**
 * The signing key for session cookies.
 *
 * SESSION_SECRET if it is set, otherwise one generated on first boot and kept
 * in the database. Generating per process would be simpler, but every restart
 * would silently sign every player out -- and a redeploy is not a reason to
 * make somebody log in again.
 */
let secretCache = null;

function secret() {
  if (secretCache) return secretCache;
  const configuredSecret = env.get('SESSION_SECRET');
  if (configuredSecret) {
    secretCache = Buffer.from(configuredSecret, 'utf8');
    return secretCache;
  }
  let stored = db.getSetting('session_secret');
  if (!stored) {
    stored = crypto.randomBytes(32).toString('hex');
    db.setSetting('session_secret', stored);
  }
  secretCache = Buffer.from(stored, 'utf8');
  return secretCache;
}

/**
 * Where Discord sends people back to.
 *
 * PUBLIC_URL wins when it is set, because behind a proxy the request headers
 * can be anything. Without it the origin is read off the request, which is what
 * makes `npm start` on localhost work with no configuration beyond the two
 * Discord credentials. The redirect URI has to match what is registered in the
 * Discord app *exactly*, so this is the one value worth pinning in production.
 */
function origin(req) {
  const configuredOrigin = env.get('PUBLIC_URL');
  if (configuredOrigin) return configuredOrigin.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0].trim();
  return `${proto}://${host}`;
}

function redirectUri(req) {
  return `${origin(req)}/auth/discord/callback`;
}

/* --------------------------------------------------------------- cookies */

/** Parse a Cookie header into a plain object. */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || out[name] !== undefined) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[name] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/**
 * `Secure` is decided by the origin rather than hardcoded: a Secure cookie is
 * simply dropped over plain http, which would make local development look like
 * a broken login rather than a missing TLS certificate.
 */
function setCookie(res, req, name, value, maxAgeMs) {
  const secure = origin(req).startsWith('https://');
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];
  if (secure) bits.push('Secure');
  appendCookie(res, bits.join('; '));
}

function clearCookie(res, req, name) {
  const secure = origin(req).startsWith('https://');
  const bits = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) bits.push('Secure');
  appendCookie(res, bits.join('; '));
}

function appendCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) return res.setHeader('Set-Cookie', [cookie]);
  res.setHeader('Set-Cookie', (Array.isArray(existing) ? existing : [existing]).concat(cookie));
}

/* --------------------------------------------------------------- signing */

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload) {
  const body = b64(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/**
 * The payload of a token we signed, or null.
 *
 * Compared with timingSafeEqual, which needs both sides to be the same length
 * -- a forged token of the wrong length would throw rather than return false,
 * so the lengths are checked first.
 */
function unsign(token) {
  const raw = String(token || '');
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;

  const body = raw.slice(0, dot);
  const given = Buffer.from(raw.slice(dot + 1), 'base64url');
  const want = crypto.createHmac('sha256', secret()).update(body).digest();
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- sessions */

/** The signed-in user carried by a Cookie header, or null. */
function userFromCookies(header) {
  const session = unsign(parseCookies(header)[SESSION_COOKIE]);
  if (!session || !session.id) return null;
  if (!(session.exp > Date.now())) return null;
  return { id: String(session.id), username: String(session.username || 'Player'), avatar: session.avatar || null };
}

/** The signed-in user on an Express request, or null. */
function currentUser(req) {
  return userFromCookies(req.headers.cookie);
}

/**
 * The signed-in user behind a socket.io connection, or null.
 *
 * The handshake is an ordinary HTTP request, so the session cookie is already
 * there -- no separate socket authentication step, and nothing the client could
 * assert about who it is. This is what stops somebody joining a daily room that
 * is not theirs; see server/index.js.
 */
function userFromSocket(socket) {
  return userFromCookies(socket.handshake && socket.handshake.headers
    ? socket.handshake.headers.cookie
    : null);
}

/** Express middleware: hangs `req.user` off every request. */
function attachUser(req, _res, next) {
  req.user = currentUser(req);
  next();
}

/** Discord's CDN URL for an avatar, or null if they have none set. */
function avatarUrl(id, hash, size = 64) {
  if (!hash) return null;
  const ext = String(hash).startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${id}/${hash}.${ext}?size=${size}`;
}

/* ----------------------------------------------------------------- flow */

/**
 * Mount /auth/*.
 *
 * `returnTo` is carried inside the signed state rather than in a cookie of its
 * own, so it cannot be tampered with -- and it is forced to a same-site path on
 * the way back out, since an attacker-chosen absolute URL here would turn the
 * callback into an open redirect.
 */
function mount(app) {
  app.get('/auth/discord', (req, res) => {
    if (!configured()) {
      return res.status(503).send('Discord sign-in is not configured on this server.');
    }

    const state = sign({
      nonce: crypto.randomBytes(12).toString('base64url'),
      returnTo: safePath(req.query.returnTo),
      exp: Date.now() + STATE_MS
    });
    setCookie(res, req, STATE_COOKIE, state, STATE_MS);

    const params = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri(req),
      response_type: 'code',
      scope: 'identify',
      state
    });
    // Skip the "authorize?" screen for someone who has already said yes once.
    // Dropped on the retry the callback sends here when Discord answers
    // `consent_required`, which is a first sign-in -- keeping it would bounce
    // that person between the two routes forever.
    if (!req.query.consent) params.set('prompt', 'none');
    res.redirect(`${DISCORD_AUTHORIZE}?${params}`);
  });

  app.get('/auth/discord/callback', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    clearCookie(res, req, STATE_COOKIE);

    const state = unsign(req.query.state);
    // Both halves matter. The signature says the state is ours; the cookie says
    // it belongs to *this browser*, which is what actually defeats CSRF -- an
    // attacker can replay a signed state they were handed, but not one that
    // never reached their victim's cookie jar.
    if (!state || !(state.exp > Date.now()) || cookies[STATE_COOKIE] !== req.query.state) {
      return fail(res, req, 'That sign-in link expired. Try again.');
    }
    if (req.query.error) {
      // The commonest one by far is `consent_required`, from prompt=none on a
      // first sign-in. Sending them round again without it is the fix.
      if (req.query.error === 'consent_required' || req.query.error === 'interaction_required') {
        return res.redirect(`/auth/discord?returnTo=${encodeURIComponent(state.returnTo)}&consent=1`);
      }
      return fail(res, req, 'Discord sign-in was cancelled.');
    }

    const code = String(req.query.code || '');
    if (!code) return fail(res, req, 'Discord did not send a sign-in code.');

    let profile;
    try {
      profile = await exchange(code, redirectUri(req));
    } catch (err) {
      console.warn('[auth] discord exchange failed:', err.message);
      return fail(res, req, 'Could not reach Discord. Give it a moment and try again.');
    }

    setCookie(res, req, SESSION_COOKIE, sign({
      id: profile.id,
      username: profile.username,
      avatar: profile.avatar,
      exp: Date.now() + SESSION_MS
    }), SESSION_MS);

    res.redirect(state.returnTo);
  });

  app.post('/auth/logout', (req, res) => {
    clearCookie(res, req, SESSION_COOKIE);
    res.json({ ok: true });
  });

  /** Who the browser is, for the client to paint a header with. */
  app.get('/api/me', (req, res) => {
    const user = currentUser(req);
    res.json({
      configured: configured(),
      user: user
        ? { id: user.id, username: user.username, avatar: avatarUrl(user.id, user.avatar) }
        : null
    });
  });
}

/**
 * Only same-site paths, and never back into /auth -- an absolute URL here is
 * the classic open redirect, and a path that starts `//` is an absolute URL
 * wearing a path's clothes.
 */
function safePath(value) {
  const path = String(value || '');
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/auth')) return '/daily';
  return path.slice(0, 200);
}

function fail(res, req, message) {
  const back = `/daily?error=${encodeURIComponent(message)}`;
  res.redirect(back);
}

/** Trade the callback code for a profile. The token is used once and dropped. */
async function exchange(code, uri) {
  const tokenRes = await fetch(DISCORD_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: 'authorization_code',
      code,
      redirect_uri: uri
    })
  });
  if (!tokenRes.ok) {
    throw new Error(`token endpoint returned ${tokenRes.status}`);
  }
  const token = await tokenRes.json();
  if (!token.access_token) throw new Error('no access token in response');

  const userRes = await fetch(DISCORD_USER, {
    headers: { Authorization: `Bearer ${token.access_token}` }
  });
  if (!userRes.ok) throw new Error(`users/@me returned ${userRes.status}`);
  const user = await userRes.json();
  if (!user.id) throw new Error('no user id in response');

  return {
    id: String(user.id),
    // global_name is the current display name; `username` is the handle, which
    // is what older accounts still show. Either is fine on a leaderboard.
    username: String(user.global_name || user.username || 'Player').slice(0, 32),
    avatar: user.avatar || null
  };
}

module.exports = {
  mount,
  configured,
  currentUser,
  userFromSocket,
  attachUser,
  avatarUrl,
  SESSION_COOKIE
};
