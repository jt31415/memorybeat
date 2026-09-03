'use strict';

// Must come first: everything below may read process.env.
require('./env');

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { packSummaries, selectPacks, defaultSelection, registerImport } = require('./packs');
const { urlForToken, fetchClip, resolveMany, searchHealth } = require('./itunes');
const { createRoom, getRoom, rooms, MODE_CATALOG, DEFAULT_MODE } = require('./game');
const { LEVELS, DEFAULT_DIFFICULTY } = require('./difficulty');
const playlists = require('./playlists');
const auth = require('./auth');
const daily = require('./daily');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 20000 });

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
// A playlist URL is the only body this server takes, so the cap is tiny.
app.use(express.json({ limit: '4kb' }));
// Everything below can ask who is signed in via req.user (null when nobody is).
app.use(auth.attachUser);

auth.mount(app);

app.get('/api/packs', (_req, res) => res.json(packSummaries()));

/**
 * The answering modes, with the words that describe them.
 *
 * Served rather than hardcoded in the client for the same reason the difficulty
 * bands are: the lobby builds a card per entry, so a mode added to the
 * catalogue in game.js turns up in the lobby without the page being touched --
 * and no id the client can offer is one the server would refuse.
 */
app.get('/api/modes', (_req, res) => res.json({ default: DEFAULT_MODE, modes: MODE_CATALOG }));

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

/* ------------------------------------------------------- daily challenge */

/**
 * The room id a daily run is played under.
 *
 * Derived from the Discord account rather than from the browser's localStorage
 * pid, which is what makes the run belong to a *person*: two tabs are one
 * player, a cleared browser rejoins the run it left, and nothing the client
 * sends can claim to be somebody else. See the room:join guard below.
 */
function dailyPid(discordId) {
  return `d:${discordId}`;
}

/** This account's unfinished run for today, if a room is still holding one. */
function liveDailyRoom(day, discordId) {
  const pid = dailyPid(discordId);
  for (const room of rooms.values()) {
    if (room.daily && room.daily.day === day && room.hostPid === pid && room.state !== 'ended') {
      return room;
    }
  }
  return null;
}

/**
 * Everything the daily page paints itself with, in one request: who you are,
 * whether you have played, and both boards.
 */
app.get('/api/daily', (req, res) => {
  const day = daily.today();
  const user = req.user;
  const mine = user ? daily.todayRank(day, user.id) : null;
  const live = user && !mine ? liveDailyRoom(day, user.id) : null;

  res.json({
    day,
    rounds: daily.DAILY_ROUNDS,
    resetsAt: daily.nextReset(),
    // A deployment with no Discord credentials cannot run this mode at all, and
    // saying so beats a sign-in button that leads to an error page.
    available: auth.configured(),
    user: user
      ? { id: user.id, name: user.username, avatar: auth.avatarUrl(user.id, user.avatar) }
      : null,
    played: mine,
    // A run that was started and walked away from. Offered back rather than
    // silently replaced: refreshing at the wrong moment should not cost
    // somebody the songs they were halfway through.
    resume: live ? live.code : null,
    today: daily.todayBoard(day),
    allTime: daily.allTimeBoard()
  });
});

/** Either board on its own, for a refresh that does not need the rest. */
app.get('/api/daily/leaderboard', (req, res) => {
  const day = daily.isDayKey(req.query.day) ? String(req.query.day) : daily.today();
  res.json({ day, today: daily.todayBoard(day), allTime: daily.allTimeBoard() });
});

/**
 * Claim today's run and get a room to play it in.
 *
 * The rules the mode rests on are all enforced right here, on the server, where
 * the client cannot reach them: you must be signed in, you get one *finished*
 * run per day, and the songs come from daily.challenge() rather than from
 * anything the request asked for.
 */
app.post('/api/daily/start', async (req, res) => {
  if (!auth.configured()) {
    return res.status(503).json({ error: 'Discord sign-in is not configured on this server.' });
  }
  const user = req.user;
  if (!user) return res.status(401).json({ error: 'Sign in with Discord to play the daily.' });

  const day = daily.today();
  if (daily.runFor(day, user.id)) {
    return res.status(409).json({ error: "You've already played today's challenge." });
  }

  // Resume beats restart unless the player explicitly asked to start over --
  // the common case for hitting this twice is a stray refresh, not a decision.
  const live = liveDailyRoom(day, user.id);
  if (live && !(req.body && req.body.restart)) {
    return res.json({ code: live.code, resumed: true });
  }
  if (live) live.destroy();

  let tracks;
  try {
    tracks = await daily.challenge(day);
  } catch (err) {
    console.error('[daily] could not build the challenge:', err.message);
    tracks = [];
  }
  if (tracks.length < daily.DAILY_ROUNDS) {
    return res.status(503).json({
      error: "Today's songs could not be loaded — iTunes is likely rate limiting us. Try again in a few minutes."
    });
  }

  const room = createRoom(io, {
    solo: true,
    packIds: [daily.DAILY_PACK],
    rounds: tracks.length,
    // Typed answers, always. Multiple choice is a different game with a
    // different scoring curve, and one leaderboard cannot hold both.
    mode: 'classic',
    hostPid: dailyPid(user.id),
    daily: { day, user },
    fixedTracks: tracks
  });

  res.json({ code: room.code, resumed: false });
});

/**
 * The difficulty slider's named stops. Served rather than hardcoded in the
 * client so the labels a player reads and the bands the sampler uses cannot
 * drift apart.
 */
app.get('/api/difficulty', (_req, res) => {
  res.json({ default: DEFAULT_DIFFICULTY, levels: LEVELS });
});

/**
 * The little the room page needs to know before anybody has joined.
 *
 * Just enough to word the join gate: whether the room is there at all, and
 * whether it is a daily run (which asks for no name, because the name comes
 * from Discord). Deliberately nothing about who is in it or what is playing --
 * that arrives over the socket, after the join has been allowed.
 */
app.get('/api/room/:code', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ exists: false });
  res.json({
    exists: true,
    solo: room.solo,
    daily: !!room.daily,
    hasPassword: !!room.password
  });
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

    let pid = String((opts && opts.pid) || '').slice(0, 40) || socket.id;
    let name = opts && opts.name;

    // A daily room belongs to one Discord account, and the handshake cookie is
    // the only thing that gets to say which. The client's pid is ignored
    // outright -- accepting it would let anybody who saw a room code in a URL
    // walk into somebody else's run and play it for them.
    if (room.daily) {
      const user = auth.userFromSocket(socket);
      if (!user || dailyPid(user.id) !== room.hostPid) {
        return reply({ error: 'That daily challenge belongs to somebody else.' });
      }
      pid = room.hostPid;
      name = user.username;
    }

    const known = room.players.get(pid);

    if (room.solo && room.hostPid !== pid) {
      return reply({ error: 'That is a single player game.' });
    }
    // Somebody the room voted out, back with the code still in their address
    // bar. Checked before the password, since knowing it is not the point.
    const bannedUntil = room.bannedUntil(pid);
    if (bannedUntil) {
      const mins = Math.max(1, Math.ceil((bannedUntil - Date.now()) / 60000));
      return reply({
        error: `You were removed from this room. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`
      });
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

    const player = room.addPlayer({ pid, name, socketId: socket.id });
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

    // A daily has no lobby worth sitting in -- no packs to pick, no difficulty
    // to slide, nobody to wait for. Arriving *is* pressing start.
    if (room.daily && room.state === 'lobby' && !room.started) room.start(pid);
  });

  socket.on('room:start', () => {
    const room = getRoom(socket.data.code);
    if (room) room.start(socket.data.pid);
  });

  socket.on('room:pack', (opts) => {
    const room = getRoom(socket.data.code);
    if (room) room.setPacks(socket.data.pid, packIdsFrom(opts));
  });

  socket.on('room:kick', (opts) => {
    const room = getRoom(socket.data.code);
    if (room) room.startKick(socket.data.pid, opts && opts.pid);
  });

  socket.on('room:kickvote', (opts) => {
    const room = getRoom(socket.data.code);
    if (room) room.castKick(socket.data.pid, opts && opts.yes);
  });

  socket.on('room:rounds', (opts) => {
    const room = getRoom(socket.data.code);
    if (room) room.setRounds(socket.data.pid, opts && opts.rounds);
  });

  socket.on('room:mix', (opts) => {
    const room = getRoom(socket.data.code);
    if (room) room.setMix(socket.data.pid, opts && opts.mix);
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
    // Never for a daily: the songs are the same five, and the player has just
    // heard all of them.
    if (!room || room.daily || room.state !== 'ended' || socket.data.pid !== room.hostPid) return;
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

/**
 * Settle the day's songs before anybody asks for them, and again just after
 * each reset.
 *
 * Purely a head start: the first player of the day would settle it themselves
 * (see daily.challenge), but that means wearing a cold iTunes lookup for five
 * songs on the loading screen. setTimeout is re-armed each time rather than
 * setInterval'd, because the gap to the next UTC midnight is not a constant.
 */
function scheduleDailyWarm() {
  if (!auth.configured()) return; // nobody can play it, so nothing to warm
  daily.warm();
  const wait = Math.max(1000, daily.nextReset() - Date.now() + 5000);
  setTimeout(scheduleDailyWarm, wait).unref();
}

server.listen(PORT, () => {
  console.log(`MemoryBeat running at http://localhost:${PORT}`);
  if (!auth.configured()) {
    console.log('[daily] Discord sign-in is not configured — the daily challenge is switched off. '
      + 'See .env.example.');
  }
  scheduleDailyWarm();
});
