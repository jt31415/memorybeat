'use strict';

// Must come first: everything below may read process.env.
require('./env');

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { packSummaries, selectPacks, defaultSelection, registerImport } = require('./packs');
const { urlForToken, fetchClip, resolveMany, searchHealth } = require('./itunes');
const { createRoom, getRoom } = require('./game');
const { LEVELS, DEFAULT_DIFFICULTY } = require('./difficulty');
const playlists = require('./playlists');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 20000 });

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
// A playlist URL is the only body this server takes, so the cap is tiny.
app.use(express.json({ limit: '4kb' }));

app.get('/api/packs', (_req, res) => res.json(packSummaries()));

/* ------------------------------------------------------- playlist import */

/**
 * How long an import will wait on iTunes before giving up on the *check*.
 *
 * Shorter than the game's own LOAD_DEADLINE_MS, and that is the point: the game
 * can afford to grind because the alternative is not starting, whereas an import
 * has an obvious fallback -- report what we know and let the player decide. A
 * warm playlist never reaches this at all, since cached tracks cost no network.
 */
const IMPORT_PROBE_MS = 8000;

/** Which sources this deployment can actually import from. */
app.get('/api/playlist/sources', (_req, res) => {
  res.json({ sources: playlists.sources(), minPlayable: playlists.MIN_PLAYABLE });
});

/**
 * Import a playlist and report whether it can actually fill a game.
 *
 * The check is the substance of this route. A playlist is a list of titles
 * somebody chose, not a curated pack -- iTunes will not have all of it, and
 * unlike a 900-track pack there is no long tail to fall back on. Discovering
 * that on the loading screen produces a mysteriously short game (game.js sets
 * totalRounds to whatever it managed to load), so the count is established here,
 * before anyone presses start, and reported honestly.
 *
 * `playable` is a floor, not a total: resolveMany stops once it has enough, so a
 * cold playlist is confirmed only up to MIN_PLAYABLE. `playableExact` says which
 * kind of number it is, so the client can phrase it truthfully.
 */
app.post('/api/playlist/import', async (req, res) => {
  const url = String((req.body && req.body.url) || '').trim().slice(0, 500);
  if (!url) return res.status(400).json({ error: 'Paste a playlist link first.' });

  let playlist;
  try {
    playlist = await playlists.fetchPlaylist(url);
  } catch (err) {
    const status = Number(err.status) || 502;
    if (status >= 500 && status !== 501) console.warn('[playlist] import failed:', err.message);
    return res.status(status).json({ error: err.message });
  }

  // Cached tracks are counted for free; only a cold playlist spends any network
  // here, and then only until MIN_PLAYABLE of them are confirmed.
  let playable = [];
  try {
    playable = await resolveMany(playlist.tracks, {
      enough: playlists.MIN_PLAYABLE,
      deadlineMs: IMPORT_PROBE_MS
    });
  } catch (err) {
    console.warn('[playlist] playability check failed:', err.message);
  }

  if (playable.length < playlists.MIN_PLAYABLE) {
    // Three different problems present as the same number, and each has its own
    // remedy -- so they get their own sentences. Telling someone their playlist
    // is full of unfindable songs when it is simply short, or when the real
    // trouble is our own rate limit, sends them off to fix the wrong thing.
    const health = searchHealth();
    const throttled = health.throttleStreak > 0 || health.blockedMs > 0;
    const short = playable.length >= playlist.imported;

    let error;
    if (throttled) {
      error = 'iTunes is rate limiting us at the moment, so we could not finish '
        + 'checking this playlist. Give it a minute and try again.';
    } else if (short) {
      // Every track resolved; there just are not enough of them.
      error = `That playlist only has ${playlist.imported} song`
        + `${playlist.imported === 1 ? '' : 's'}, and a game needs at least `
        + `${playlists.MIN_PLAYABLE}.`;
    } else {
      error = `Only ${playable.length} of ${playlist.imported} songs could be found `
        + `on iTunes, and a game needs at least ${playlists.MIN_PLAYABLE}. `
        + 'Playlists of non-Western or very obscure music tend to come up short.';
    }

    return res.status(422).json({
      error,
      throttled,
      playable: playable.length,
      imported: playlist.imported
    });
  }

  const selection = registerImport(playlist);

  res.json({
    id: selection.ids[0],
    name: playlist.name,
    source: playlist.source,
    label: playlist.label,
    url: playlist.url,
    imported: playlist.imported,
    duplicates: playlist.duplicates,
    truncated: playlist.truncated,
    playable: playable.length,
    // True when every track was checked, which only happens if the whole
    // playlist was already cached or it is shorter than MIN_PLAYABLE allows.
    playableExact: playable.length >= playlist.imported
  });
});

/**
 * The difficulty slider's named stops. Served rather than hardcoded in the
 * client so the labels a player reads and the bands the sampler uses cannot
 * drift apart.
 */
app.get('/api/difficulty', (_req, res) => {
  res.json({ default: DEFAULT_DIFFICULTY, levels: LEVELS });
});

/** Shareable room link: /r/ABCD */
app.get('/r/:code', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'room.html')));

/**
 * Audio proxy. The token is minted per round, so the client never learns the
 * iTunes URL (which would give the song title away).
 */
app.get('/a/:token', async (req, res) => {
  const url = urlForToken(req.params.token);
  if (!url) return res.status(404).end();

  let buf;
  try {
    buf = await fetchClip(url);
  } catch (err) {
    console.warn('[audio] fetch failed:', err.message);
    return res.status(502).end();
  }

  res.setHeader('Content-Type', 'audio/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');

  const range = req.headers.range;
  const match = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (match) {
    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? Math.min(parseInt(match[2], 10), buf.length - 1) : buf.length - 1;
    if (Number.isNaN(start) || start > end || start >= buf.length) {
      res.setHeader('Content-Range', `bytes */${buf.length}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${buf.length}`);
    res.setHeader('Content-Length', end - start + 1);
    return res.end(buf.subarray(start, end + 1));
  }

  res.setHeader('Content-Length', buf.length);
  res.end(buf);
});

/* ---------------------------------------------------------------- sockets */

/**
 * The pack ids in a client payload, as a bounded array of strings.
 *
 * Rooms play a selection of packs now, but the single-pack `packId` shape is
 * still accepted -- an open room page from before the change goes on working.
 * Unknown ids are dropped by packs.selectPacks; the cap is only here so a
 * hostile client cannot hand us a huge list to sift.
 */
function packIdsFrom(opts) {
  const raw = opts && (Array.isArray(opts.packIds) ? opts.packIds : opts.packId);
  const ids = Array.isArray(raw) ? raw : [raw];
  // Empties are dropped so that "sent nothing" is distinguishable from "sent
  // something unrecognisable" -- room:create treats those two very differently.
  return ids.slice(0, 64).map((id) => String(id || '').slice(0, 60)).filter(Boolean);
}

function leaveCurrentRoom(socket) {
  const { code, pid } = socket.data || {};
  if (!code) return;
  const room = getRoom(code);
  socket.leave(code);
  if (!room) return;
  const player = room.players.get(pid);
  room.removePlayer(pid);
  if (player) room.system('leave', `${player.name} left.`, { pid, name: player.name });
  room.syncState();
  socket.data.code = null;
}

io.on('connection', (socket) => {
  socket.data = { pid: null, code: null };

  socket.on('room:create', (opts, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const ids = packIdsFrom(opts);
    // Songs are chosen from the lobby, not here, so an empty payload is the
    // normal case and gets a default to start from. Ids that were sent and did
    // not resolve are a different matter -- that is a real failure, and saying
    // so beats silently seating the room on a pack nobody asked for.
    const selection = ids.length ? selectPacks(ids) : defaultSelection();
    if (!selection) {
      const stale = ids.some((id) => id.startsWith('pl:'));
      return reply({
        error: stale
          ? 'That playlist import has expired. Import it again.'
          : 'No song packs are loaded. Run `npm run build-packs`.'
      });
    }

    const pid = String((opts && opts.pid) || '').slice(0, 40) || socket.id;
    const room = createRoom(io, {
      solo: !!opts.solo,
      packIds: selection.ids,
      password: opts.solo ? '' : String(opts.password || '').slice(0, 40),
      maxPlayers: opts.maxPlayers,
      rounds: opts.rounds,
      difficulty: opts.difficulty,
      mode: opts.mode,
      hostPid: pid
    });
    reply({ code: room.code });
  });

  socket.on('room:join', (opts, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = getRoom(opts && opts.code);
    if (!room) return reply({ error: 'That room does not exist (or it already closed).' });

    const pid = String((opts && opts.pid) || '').slice(0, 40) || socket.id;
    const known = room.players.get(pid);

    if (room.solo && room.hostPid !== pid) {
      return reply({ error: 'That is a single player game.' });
    }
    if (!known && room.password && String(opts.password || '') !== room.password) {
      return reply({ error: 'Wrong password.', needPassword: true });
    }
    if (!known && room.isFull()) return reply({ error: 'That room is full.' });

    // One tab per player: drop any older socket holding the same pid.
    for (const [id, other] of io.sockets.sockets) {
      if (id !== socket.id && other.data && other.data.pid === pid && other.data.code === room.code) {
        other.emit('room:kicked', { message: 'You opened this room in another tab.' });
        other.leave(room.code);
        other.data.code = null;
      }
    }

    socket.data.pid = pid;
    socket.data.code = room.code;
    socket.join(room.code);

    const player = room.addPlayer({ pid, name: opts.name, socketId: socket.id });
    room.ensureHost();
    reply({ ok: true, you: pid, state: room.publicState() });
    if (!known) room.system('join', `${player.name} joined.`, { pid, name: player.name });
    room.syncState();

    // Anyone landing mid-game -- a late joiner or a reconnect -- needs the
    // current round pushed to them. During the countdown the clip has not
    // started, so they get a token and play it properly; once it is playing
    // there is no audio for them and they sit the round out. Either way the
    // next round starts them clean (see Room#nextRound).
    if (room.round && ['countdown', 'playing', 'reveal'].includes(room.state)) {
      // Only the countdown is playable -- mid-clip they have no audio, and
      // during the reveal the round is already over.
      const playable = room.state === 'countdown' && player.spectating !== room.roundIndex;
      socket.emit('round:prepare', room.preparePayload({ token: playable, rejoin: !playable }));
    }

    // Landing on a finished game: the state alone puts them on the final screen,
    // which without this would be an empty scoreboard with no songs on it.
    if (room.state === 'ended' && room.summary) socket.emit('game:over', room.summary);
  });

  socket.on('room:start', () => {
    const room = getRoom(socket.data.code);
    if (room) room.start(socket.data.pid);
  });

  socket.on('room:pack', (opts) => {
    const room = getRoom(socket.data.code);
    if (room) room.setPacks(socket.data.pid, packIdsFrom(opts));
  });

  socket.on('room:mode', (opts) => {
    const room = getRoom(socket.data.code);
    if (room) room.setMode(socket.data.pid, opts && opts.mode);
  });

  socket.on('round:choose', (opts) => {
    const room = getRoom(socket.data.code);
    if (room) room.submitChoice(socket.data.pid, opts && opts.index);
  });

  socket.on('round:skip', () => {
    const room = getRoom(socket.data.code);
    if (room) room.skip(socket.data.pid);
  });

  socket.on('room:difficulty', (opts) => {
    const room = getRoom(socket.data.code);
    if (room) room.setDifficulty(socket.data.pid, opts && opts.value);
  });

  socket.on('room:again', () => {
    const room = getRoom(socket.data.code);
    if (!room || room.state !== 'ended' || socket.data.pid !== room.hostPid) return;
    room.clearTimers();
    room.state = 'lobby';
    room.roundIndex = -1;
    room.totalRounds = room.configuredRounds; // a short game shouldn't shrink the next one
    for (const player of room.players.values()) {
      player.score = 0;
      player.solved = false;
    }
    room.broadcast('game:reset', {});
    room.syncState();
  });

  socket.on('round:ready', () => {
    const room = getRoom(socket.data.code);
    if (room) room.markReady(socket.data.pid);
  });

  socket.on('chat:send', (payload) => {
    const room = getRoom(socket.data.code);
    if (room) room.chat(socket.data.pid, payload && payload.text);
  });

  socket.on('room:leave', () => leaveCurrentRoom(socket));
  socket.on('disconnect', () => leaveCurrentRoom(socket));
});

server.listen(PORT, () => {
  console.log(`MemoryBeat running at http://localhost:${PORT}`);
});
