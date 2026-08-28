/* Room page: lobby, rounds, audio, visualiser, scores and chat. */

const CODE = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '').toUpperCase();
const socket = io();

/* Storage moved from the old `gts:` prefix to `mb:` with the rename. Carry the
   handful of keys across once so nobody loses their name or volume. */
(function migrateStorage() {
  try {
    if (localStorage.getItem('mb:migrated')) return;
    for (const key of ['pid', 'name', 'vol']) {
      const old = localStorage.getItem(`gts:${key}`);
      if (old !== null && localStorage.getItem(`mb:${key}`) === null) {
        localStorage.setItem(`mb:${key}`, old);
      }
    }
    localStorage.setItem('mb:migrated', '1');
  } catch { /* private mode: defaults are fine */ }
})();

const $ = (id) => document.getElementById(id);
const el = {
  layout: $('layout'),
  topCode: $('top-code'),
  topPack: $('top-pack'),
  lobby: $('lobby'),
  lobbyTitle: $('lobby-title'),
  lobbyCode: $('lobby-code'),
  lobbyError: $('lobby-error'),
  codeBadge: $('code-badge'),
  roster: $('roster'),
  // The host's whole configuration block: packs, difficulty, playlist import and
  // answer mode, in one scroller. Shown or hidden as a unit.
  lobbyConfig: $('lobby-config'),
  packList: document.querySelector('[data-packs="room"]'),
  packSum: document.querySelector('[data-pack-sum="room"]'),
  playlistBadge: $('playlist-badge'),
  playlistSource: $('playlist-source'),
  playlistName: $('playlist-name'),
  playlistCount: $('playlist-count'),
  importUrl: document.querySelector('[data-import-url="room"]'),
  importGo: document.querySelector('[data-import-go="room"]'),
  importNote: document.querySelector('[data-import-note="room"]'),
  importSum: document.querySelector('[data-import-sum="room"]'),
  modeSwitch: $('mode-switch'),
  modeBlurb: $('mode-blurb'),
  choices: $('choices'),
  settings: $('settings-line'),
  difficulty: $('difficulty'),
  diffRange: $('diff-range'),
  diffName: $('diff-name'),
  diffBlurb: $('diff-blurb'),
  start: $('start'),
  play: $('play'),
  roundLabel: $('round-label'),
  answerSlot: $('answer-slot'),
  mask: $('mask'),
  maskArtist: $('mask-artist'),
  guessBar: $('guess-bar'),
  guessInput: $('guess-input'),
  skipRow: $('skip-row'),
  skip: $('skip'),
  chatMode: $('chat-mode'),
  status: $('status'),
  timer: $('timer'),
  revealTitle: $('reveal-title'),
  sub: $('sub'),
  art: $('art'),
  vizCenter: $('viz-center'),
  final: $('final'),
  finalSub: $('final-sub'),
  leaderboard: $('leaderboard'),
  recap: $('recap'),
  recapSum: $('recap-sum'),
  recapList: $('recap-list'),
  again: $('again'),
  menuLink: $('menu-link'),
  dailyNote: $('daily-note'),
  scores: $('scores'),
  pcount: $('pcount'),
  chatLog: $('chat-log'),
  chatForm: $('chat-form'),
  chatInput: $('chat-input'),
  chatNote: $('chat-note'),
  overlay: $('join-overlay'),
  joinName: $('join-name'),
  joinPass: $('join-pass'),
  joinPassWrap: $('join-pass-wrap'),
  joinGo: $('join-go'),
  joinTitle: $('join-title'),
  joinSub: $('join-sub'),
  joinError: $('join-error'),
  audio: $('audio'),
  volume: $('volume'),
  mute: $('mute'),
  leave: $('leave')
};

// The centre overlay is handed over so the bars stay clear of the clock.
const viz = new Visualizer($('viz'), el.vizCenter);
viz.start();

let me = null;
let room = null;
let round = null;      // { index, total, timeLimit, startAt, solved, mode, picked }
let joined = false;

/* ------------------------------------------------------------ identity hue */

/* Twelve hues, all sitting at roughly the same lightness so no name shouts
   louder than the others on this background. The hue is derived from the
   player's id, so it follows them across rounds and across sessions rather
   than being reshuffled on every render. */
const NAME_HUES = [
  '#ff8a5b', '#f7c948', '#c7e86a', '#8be86a',
  '#3fd8a0', '#6fe3c8', '#4adce0', '#5fb0ff',
  '#9c8cff', '#e58bff', '#ff7ba9', '#ff6b6b'
];

function hueIndex(pid) {
  const s = String(pid || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % NAME_HUES.length;
}

const hueByPid = new Map();

/**
 * Preferred hue first, then walk to the next free one. Two people in the same
 * room never share a colour (up to twelve of them), and everybody keeps their
 * own as long as they stay. Sorted by id so the assignment is stable rather
 * than dependent on the score order it arrives in.
 */
function assignHues(players) {
  const taken = new Set();
  const spill = [];
  const ordered = [...players].sort((a, b) => (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0));

  for (const p of ordered) {
    const want = hueIndex(p.pid);
    if (taken.has(want)) spill.push(p);
    else {
      taken.add(want);
      hueByPid.set(p.pid, want);
    }
  }
  for (const p of spill) {
    const want = hueIndex(p.pid);
    let placed = false;
    for (let k = 1; k <= NAME_HUES.length; k++) {
      const j = (want + k) % NAME_HUES.length;
      if (!taken.has(j)) {
        taken.add(j);
        hueByPid.set(p.pid, j);
        placed = true;
        break;
      }
    }
    if (!placed) hueByPid.set(p.pid, want); // >12 players: duplicates are fine
  }
}

function hueFor(pid) {
  const i = hueByPid.has(pid) ? hueByPid.get(pid) : hueIndex(pid);
  return NAME_HUES[i];
}

function tint(node, pid) {
  node.style.setProperty('--hue', hueFor(pid));
}

/* --------------------------------------------------------------------- ident */

function playerId() {
  let pid = localStorage.getItem('mb:pid');
  if (!pid) {
    pid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('mb:pid', pid);
  }
  return pid;
}

/* --------------------------------------------------------------------- views */

function showView(name) {
  el.lobby.classList.toggle('hidden', name !== 'lobby');
  el.play.classList.toggle('hidden', name !== 'play');
  el.final.classList.toggle('hidden', name !== 'final');
}

/**
 * Status text is built as text nodes, never as markup. Some of what lands here
 * is another player's typed guess (the "close!" nudge), and that must not be
 * able to inject anything into the page.
 */
function setStatus(text, tone) {
  el.status.textContent = '';
  if (!text) return;
  if (!tone) {
    el.status.textContent = text;
    return;
  }
  const span = document.createElement('span');
  span.className = tone;
  span.textContent = text;
  el.status.appendChild(span);
}

/* ---------------------------------------------------------------- the clock */

/*
 * One rAF loop drives the on-screen seconds, and the visualiser reads the same
 * deadline itself every frame. That is what makes the ring sweep smoothly: it
 * is no longer being stepped forward by a 100ms interval, it interpolates from
 * the clock. The text still only changes on whole seconds, but it can never
 * disagree with the arc.
 */
let clockRaf = null;

function runClock(step) {
  stopClock();
  const tick = () => {
    if (step() === false) {
      clockRaf = null;
      return;
    }
    clockRaf = requestAnimationFrame(tick);
  };
  clockRaf = requestAnimationFrame(tick);
}

function stopClock() {
  if (clockRaf) cancelAnimationFrame(clockRaf);
  clockRaf = null;
}

function setTimer(text, glyph) {
  if (el.timer.textContent !== text) el.timer.textContent = text;
  el.timer.classList.toggle('glyph', !!glyph);
}

/* ----------------------------------------------------------------- join */

el.topCode.textContent = CODE;
el.lobbyCode.textContent = CODE;
el.joinName.value = localStorage.getItem('mb:name') || '';

let storedPass = sessionStorage.getItem(`mb:pw:${CODE}`) || '';

function attemptJoin(password) {
  el.joinError.textContent = '';
  el.joinGo.disabled = true;
  socket.emit(
    'room:join',
    { code: CODE, name: el.joinName.value.trim() || 'Player', password, pid: playerId() },
    (res) => {
      el.joinGo.disabled = false;
      if (!res || res.error) {
        if (res && res.needPassword) {
          el.joinPassWrap.classList.remove('hidden');
          el.joinTitle.textContent = 'Password required';
          el.joinSub.textContent = 'This room is locked.';
          el.joinPass.focus();
        }
        el.joinError.textContent = (res && res.error) || 'Could not join.';
        return;
      }
      joined = true;
      me = res.you;
      localStorage.setItem('mb:name', el.joinName.value.trim() || 'Player');
      if (password) {
        storedPass = password;
        sessionStorage.setItem(`mb:pw:${CODE}`, password);
      }
      el.overlay.classList.add('hidden');
      // The click that got us here is our licence to make noise.
      viz.attach(el.audio);
      viz.resume();
      applyState(res.state);
    }
  );
}

el.joinGo.addEventListener('click', () => attemptJoin(el.joinPass.value || storedPass));
el.joinName.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.joinGo.click(); });
el.joinPass.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.joinGo.click(); });

socket.on('connect', () => {
  if (joined) attemptJoin(storedPass); // silent re-join after a reconnect
});

socket.on('room:kicked', ({ message }) => {
  joined = false;
  el.overlay.classList.remove('hidden');
  el.joinError.textContent = message || 'You were disconnected.';
});

/* ------------------------------------------------------------- pack switch */

// Only the host can switch, and only between games -- mid-game the buttons are
// hidden entirely rather than shown disabled, since the lobby is not on screen
// then anyway.
// Packs are multi-select: the room plays every pack that is on, merged into one
// list. Clicking sends the whole selection rather than the pack that changed, so
// a click crossing with a state sync can't leave client and server disagreeing.
let packsLoaded = false;

function renderPackSwitch(packs) {
  el.packList.innerHTML = '';
  for (const pack of packs) {
    const btn = document.createElement('button');
    btn.className = 'pack';
    btn.dataset.packId = pack.id;
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = `
      <span class="icon"></span>
      <span class="meta">
        <strong></strong>
        <span class="blurb"></span>
        <span class="count"></span>
      </span>`;
    btn.querySelector('.icon').textContent = pack.icon;
    btn.querySelector('strong').textContent = pack.name;
    btn.querySelector('.blurb').textContent = pack.blurb;
    btn.querySelector('.count').textContent = `${pack.count} songs`;
    // No optimistic highlight: the server decides, and its state sync paints it.
    btn.addEventListener('click', () => socket.emit('room:pack', { packIds: toggledSelection(pack.id) }));
    el.packList.appendChild(btn);
  }
  packsLoaded = true;
}

/** The room's packs with one flipped -- unless flipping it off would leave the
 *  room with nothing to play, in which case the selection stands. */
function toggledSelection(packId) {
  const current = (room && room.packIds) || [];
  // Coming off a playlist there is nothing to toggle against: the server refuses
  // a playlist merged with packs (see packs.selectPacks), so a pack click means
  // "play this instead" and replaces the selection outright.
  if (room && room.playlist) return [packId];
  if (!current.includes(packId)) return current.concat(packId);
  if (current.length === 1) return current;
  return current.filter((id) => id !== packId);
}

/* Short labels for the playlist badge, in the same house style as the pack
   icons. Unknown sources fall back to "PL". */
const SOURCE_ICON = { deezer: 'DZ', spotify: 'SP' };

function updatePackSwitch(state, isHost) {
  const inLobby = state.state === 'lobby' || state.state === 'ended';
  const playlist = state.playlist;

  /* The badge is the readout, shown to everyone: it says what the room is
     playing, which non-hosts have no other way to see in full. Only playlists
     get one -- a pack selection is already spelled out in the settings line. */
  el.playlistBadge.classList.toggle('hidden', !playlist || !inLobby);
  if (playlist && inLobby) {
    // The pack icons are two- or three-character labels ("80s", "POP"), so a
    // source gets one to match rather than the first four letters of its name,
    // which reads as a truncation ("DEEZ").
    el.playlistSource.textContent = SOURCE_ICON[playlist.source] || 'PL';
    el.playlistName.textContent = playlist.name;
    el.playlistCount.textContent =
      `${(state.packCount || 0).toLocaleString()} songs · every song equally likely`;
  }

  /* The controls are the host's, and both halves stay up regardless of which is
     in force. A playlist no longer hides the pack grid: with the import box in
     here too, switching to a pack is reversible, so there is nothing to protect
     the host from. The dimming below is what says which side is live. */
  const canSwitch = isHost && inLobby;
  el.lobbyConfig.classList.toggle('hidden', !canSwitch || !packsLoaded);
  if (!canSwitch) return;

  paintImportState(state);

  const on = new Set(state.packIds || []);
  for (const btn of el.packList.querySelectorAll('.pack')) {
    btn.setAttribute('aria-pressed', String(on.has(btn.dataset.packId)));
  }
  // The server's count, so it is the merged total with duplicates already
  // folded together rather than a sum of pack sizes. Dimmed packs are not in
  // play, so a song count for them would describe nothing.
  el.packSum.textContent = state.playlist
    ? 'using playlist'
    : (on.size
      ? `${on.size} pack${on.size > 1 ? 's' : ''} · ${(state.packCount || 0).toLocaleString()} songs`
      : '');
}

fetch('/api/packs')
  .then((r) => r.json())
  .then((packs) => {
    renderPackSwitch(packs);
    if (room) updatePackSwitch(room, canConfigure(room));
  })
  .catch(() => {}); // switching is a convenience; the room still works without it

/* ---------------------------------------------------------- playlist import */

/*
 * Importing lives here rather than on the front page so that the host can change
 * what the room plays between games, and so that packs and playlists are the
 * same kind of choice made in the same place.
 *
 * The server does the deciding, as with the pack switch: an import that passes
 * its playability check is applied with room:pack, and the state sync that comes
 * back is what paints the room. Nothing is held locally -- state.playlist is the
 * single source of truth for which side is live.
 */

function setImportNote(text, tone) {
  if (!el.importNote) return;
  el.importNote.textContent = text || '';
  el.importNote.className = `import-note${tone ? ` ${tone}` : ''}`;
}

/** Dim whichever half is not in force, so the live one is obvious at a glance. */
function paintImportState(state) {
  el.packList.classList.toggle('standby', !!state.playlist);
  if (el.importSum) {
    el.importSum.textContent = state.playlist ? 'in play' : '';
  }
  // A success note describes a playlist that is in play. Once the room has moved
  // to a pack it describes nothing, and left up it reads as though the playlist
  // were still live. Failures stay: they are the reason nothing changed, and the
  // host has not read them yet.
  if (!state.playlist && el.importNote && el.importNote.classList.contains('ok')) {
    setImportNote('');
  }
}

/**
 * `playable` is a floor, not a total -- the server stops checking once it has
 * enough for a game -- so it reads "18+ of 50" rather than "18 of 50", which
 * would look like 32 failures.
 */
function describeImport(res) {
  const parts = [res.playableExact
    ? `all ${res.imported} songs playable`
    : `${res.playable}+ of ${res.imported} songs playable`];
  if (res.duplicates > 0) {
    parts.push(`${res.duplicates} duplicate${res.duplicates > 1 ? 's' : ''} merged`);
  }
  if (res.truncated) parts.push('capped at the first 1,000');
  return `${res.name} — ${parts.join(', ')}.`;
}

async function runImport() {
  const url = el.importUrl.value.trim();
  if (!url) {
    setImportNote('Paste a playlist link first.', 'bad');
    el.importUrl.focus();
    return;
  }

  el.importGo.disabled = true;
  setImportNote('Importing…', 'busy');

  let res;
  let body;
  try {
    res = await fetch('/api/playlist/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    body = await res.json();
  } catch {
    el.importGo.disabled = false;
    setImportNote('Could not reach the server. Try again.', 'bad');
    return;
  }

  el.importGo.disabled = false;

  if (!res.ok) {
    setImportNote((body && body.error) || 'Import failed.', 'bad');
    return;
  }

  setImportNote(describeImport(body), 'ok');
  // Hand it to the room the same way a pack click does. The resulting state sync
  // is what actually switches the room over.
  socket.emit('room:pack', { packIds: [body.id] });
}

if (el.importGo && el.importUrl) {
  el.importGo.addEventListener('click', runImport);
  el.importUrl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault(); // Enter in the lobby would otherwise fall through to chat
    runImport();
  });
}

/* --------------------------------------------------------------- difficulty */

/*
 * Difficulty picks which end of the pack songs come from -- see
 * server/difficulty.js. Like the pack switch it is the host's, and only between
 * games. Everyone else reads it off the settings line.
 *
 * The named bands come from the server so the label a player reads always
 * matches the weighting the sampler actually used. Until that fetch lands (or
 * if it fails) the label falls back to the name the server sends with each
 * state sync, so the slider is never unlabelled.
 */
let diffLevels = null;

/* The value the host has slid to but not yet had confirmed. While it is set,
   state syncs leave the slider alone -- otherwise an unrelated sync (someone
   joining) would yank the handle back under their thumb. */
let diffPending = null;

function diffLevelFor(value) {
  if (!diffLevels) return null;
  return diffLevels.find((level) => value <= level.upTo) || diffLevels[diffLevels.length - 1];
}

/** Paint the name and blurb for a value; `fallback` is the server's own label. */
function paintDifficulty(value, fallback) {
  const level = diffLevelFor(value);
  el.diffName.textContent = level ? level.name : (fallback || '');
  el.diffBlurb.textContent = level ? level.blurb : '';
}

function updateDifficulty(state, isHost) {
  // An imported playlist is evenly weighted, so the server ignores this setting
  // outright (see game.js#setDifficulty). Hidden rather than disabled: a slider
  // that moves and changes nothing is worse than no slider.
  const canSet = isHost
    && !state.equalWeight
    && (state.state === 'lobby' || state.state === 'ended');
  el.difficulty.classList.toggle('hidden', !canSet);
  if (!canSet) {
    diffPending = null;
    return;
  }
  // Mid-drag, or waiting on our own change to come back: leave the handle be.
  if (diffPending !== null) {
    if (state.difficulty !== diffPending) return;
    diffPending = null;
  }
  el.diffRange.value = state.difficulty;
  paintDifficulty(state.difficulty, state.difficultyLabel);
}

/* Label follows the handle live; the room only hears about it on release, so a
   drag across the slider is one event and one line of chat rather than twenty. */
el.diffRange.addEventListener('input', () => {
  paintDifficulty(Number(el.diffRange.value), null);
});

el.diffRange.addEventListener('change', () => {
  const value = Number(el.diffRange.value);
  diffPending = value;
  socket.emit('room:difficulty', { value });
});

fetch('/api/difficulty')
  .then((r) => r.json())
  .then((cfg) => {
    diffLevels = cfg.levels;
    if (room) paintDifficulty(Number(el.diffRange.value), room.difficultyLabel);
  })
  .catch(() => {}); // the server's own label carries it

/* ------------------------------------------------------------- answer mode */

/*
 * Typing the title or picking it out of four. Host's, lobby-only, and shown to
 * everyone else on the settings line -- the same deal as the pack and the
 * difficulty. No optimistic highlight: the server's state sync paints it, so a
 * click that crosses with a sync cannot leave the two disagreeing.
 */
const MODE_LABEL = { classic: 'Type it', choice: 'Multiple choice' };
const MODE_BLURB = {
  classic: 'First to type the title wins the round',
  choice: 'One guess each — the wrong card costs you the round'
};

function currentMode() {
  return (room && room.mode) || 'classic';
}

function updateModeSwitch(state, isHost) {
  const canSet = isHost && (state.state === 'lobby' || state.state === 'ended');
  el.modeSwitch.classList.toggle('hidden', !canSet);
  el.modeBlurb.textContent = MODE_BLURB[state.mode] || '';
  for (const btn of el.modeSwitch.querySelectorAll('.mode-opt')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === state.mode));
  }
}

for (const btn of el.modeSwitch.querySelectorAll('.mode-opt')) {
  btn.addEventListener('click', () => socket.emit('room:mode', { mode: btn.dataset.mode }));
}

/* -------------------------------------------------------------- room state */

/**
 * Whether this browser gets the lobby's settings controls.
 *
 * The host, in an ordinary room. Never in a daily one: every setting there is
 * fixed for the day, and a control that cannot change anything is worse than
 * no control at all. The server refuses the changes regardless (see
 * Room#setPacks and friends) -- this is only what stops us offering them.
 */
function canConfigure(state) {
  return !!state && state.hostPid === me && !state.daily;
}

function applyState(state) {
  room = state;
  assignHues(state.players);

  el.layout.classList.toggle('solo', !!state.solo);
  el.topPack.textContent = state.packName;
  el.pcount.textContent = state.solo ? '' : `${state.players.filter((p) => p.connected).length}/${state.maxPlayers}`;

  const isHost = state.hostPid === me;
  // A daily room has nothing to configure and nothing to press: the songs, the
  // mode, the difficulty and the round count are the same for everybody today,
  // and joining starts it. So the host controls are not merely disabled, they
  // are gone -- there is no version of this room where they would apply.
  const isDaily = !!state.daily;
  el.start.classList.toggle('hidden', !isHost || isDaily);
  el.start.disabled = state.state === 'loading';
  el.start.textContent = state.state === 'loading' ? 'Loading songs…' : (state.state === 'ended' ? 'New game' : 'Start game');
  el.again.classList.toggle('hidden', !isHost || isDaily);
  if (isDaily) {
    el.menuLink.href = '/daily';
    el.menuLink.textContent = 'Daily challenge';
    // The code is a private handle on one person's run, not something to share.
    el.topCode.textContent = 'Daily';
  }
  // Each of these hides its own control when handed false, so the daily gets
  // an empty lobby for free rather than needing a second way to blank it.
  updatePackSwitch(state, canConfigure(state));
  updateDifficulty(state, canConfigure(state));
  updateModeSwitch(state, canConfigure(state));

  el.codeBadge.classList.toggle('hidden', !!state.solo);
  el.lobbyTitle.textContent = isDaily
    ? "Loading today's five songs…"
    : (state.solo
      ? 'Ready when you are'
      : (isHost ? 'Your room is ready' : 'Waiting for the host to start'));

  el.settings.innerHTML = '';
  const bits = [
    // A playlist is labelled as one: "Pack: Road Trip 2019" would misdescribe
    // where the songs came from, and the distinction matters to a player working
    // out why they have never heard any of them.
    state.playlist
      ? ['Playlist', state.packName]
      : [(state.packIds || []).length > 1 ? 'Packs' : 'Pack', state.packName],
    ['Rounds', state.totalRounds],
    // Difficulty genuinely does not apply to an imported playlist, so it says so
    // rather than reporting the inert stored value as though it were in force.
    ['Difficulty', state.equalWeight ? 'even' : (state.difficultyLabel || '—')],
    ['Answering', MODE_LABEL[state.mode] || MODE_LABEL.classic],
    ...(state.solo ? [] : [['Max players', state.maxPlayers], ['Password', state.hasPassword ? 'on' : 'off']])
  ];
  for (const [k, v] of bits) {
    const span = document.createElement('span');
    span.appendChild(document.createTextNode(`${k} `));
    const b = document.createElement('b');
    b.textContent = v;
    span.appendChild(b);
    el.settings.appendChild(span);
  }

  renderRoster(state);
  renderScores(state.players);

  if (state.state === 'lobby' || state.state === 'loading') {
    showView('lobby');
    stopClock();
    viz.setEmpty();
    stopAudio();
    clearRoundBoard();
  } else if (state.state === 'ended') {
    showView('final');
    viz.setEmpty();
  } else if (!round) {
    showView('play');
  }
}

function renderRoster(state) {
  el.roster.innerHTML = '';
  for (const p of state.players) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (p.connected ? '' : ' away');
    tint(chip, p.pid);
    chip.appendChild(document.createTextNode(p.name));
    if (p.isHost) {
      const tag = document.createElement('span');
      tag.className = 'host';
      tag.textContent = 'HOST';
      chip.appendChild(tag);
    }
    el.roster.appendChild(chip);
  }
}

/* ------------------------------------------------------------------- scores */

/*
 * Score rows are kept and reused rather than rebuilt, so a change in the
 * standings can be animated: measure, reorder, then FLIP each row from where
 * it used to be. Blowing the list away every sync made ranks teleport, which
 * is exactly the moment you most want to see.
 */
const scoreRows = new Map();   // pid -> element
const lastScore = new Map();   // pid -> last rendered score

function buildScoreRow(p) {
  const row = document.createElement('div');
  row.dataset.pid = p.pid;
  row.innerHTML = '<span class="rank"></span><span class="dot"></span><span class="nm"></span><span class="pts"></span>';
  return row;
}

function renderScores(players) {
  assignHues(players);

  // Where is everything now, before we touch the order?
  const before = new Map();
  for (const [pid, row] of scoreRows) before.set(pid, row.getBoundingClientRect().top);

  const seen = new Set();
  players.forEach((p, i) => {
    let row = scoreRows.get(p.pid);
    if (!row) {
      row = buildScoreRow(p);
      scoreRows.set(p.pid, row);
    }
    row.className = 'score-row' + (p.pid === me ? ' you' : '') + (p.connected === false ? ' away' : '');
    tint(row, p.pid);
    row.querySelector('.rank').textContent = i + 1;
    row.querySelector('.dot').classList.toggle('answered', !!p.answered);
    row.querySelector('.nm').textContent = p.name;

    const pts = row.querySelector('.pts');
    pts.textContent = p.score;
    const prev = lastScore.get(p.pid);
    if (prev != null && p.score > prev) {
      pts.classList.remove('bumped');
      void pts.offsetWidth;        // restart the animation
      pts.classList.add('bumped');
    }
    lastScore.set(p.pid, p.score);

    el.scores.appendChild(row);    // already a child? this just moves it
    seen.add(p.pid);
  });

  for (const [pid, row] of [...scoreRows]) {
    if (seen.has(pid)) continue;
    row.remove();
    scoreRows.delete(pid);
    lastScore.delete(pid);
  }

  // ...and slide each one from where it was to where it landed.
  for (const [pid, row] of scoreRows) {
    const was = before.get(pid);
    if (was == null) continue;
    const dy = was - row.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    row.style.transition = 'none';
    row.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => {
      row.style.transition = '';
      row.style.transform = '';
    });
  }
}

socket.on('room:state', applyState);
socket.on('room:error', ({ message }) => {
  el.lobbyError.textContent = message;
  setStatus(message, 'bad');
});

/* -------------------------------------------------------------------- audio */

/* The element's volume is the player's setting multiplied by a fade gain, so a
   fade in progress can never be mistaken for -- or overwrite -- the level the
   player chose with the slider. */
let userVolume = Number(localStorage.getItem('mb:vol') ?? 80) / 100;
let fadeGain = 1;
let fadeToken = 0;

el.volume.value = Math.round(userVolume * 100);

function applyVolume() {
  el.audio.volume = Math.max(0, Math.min(1, userVolume * fadeGain));
}

let lastVolume = userVolume || 0.8;

function paintVolume() {
  const v = el.audio.muted || userVolume === 0;
  el.mute.textContent = v ? '🔇' : userVolume < 0.45 ? '🔉' : '🔊';
  el.mute.classList.toggle('muted', v);
  el.mute.setAttribute('aria-label', v ? 'Unmute' : 'Mute');
  el.mute.title = v ? 'Unmute' : 'Mute';
}

el.volume.addEventListener('input', () => {
  userVolume = Number(el.volume.value) / 100;
  el.audio.muted = false;
  if (userVolume > 0) lastVolume = userVolume;
  localStorage.setItem('mb:vol', el.volume.value);
  applyVolume();
  paintVolume();
});

el.mute.addEventListener('click', () => {
  if (userVolume === 0 || el.audio.muted) {
    el.audio.muted = false;
    userVolume = lastVolume || 0.8;
  } else {
    lastVolume = userVolume;
    userVolume = 0;
  }
  el.volume.value = Math.round(userVolume * 100);
  localStorage.setItem('mb:vol', el.volume.value);
  applyVolume();
  paintVolume();
});

applyVolume();
paintVolume();

function stopAudio() {
  endAudioPhase();
  cancelFade();
  try {
    el.audio.pause();
    el.audio.removeAttribute('src');
    el.audio.load();
  } catch { /* nothing to stop */ }
}

/** Drop any fade in flight and put the clip back at the player's own level. */
function cancelFade() {
  fadeToken += 1;
  fadeGain = 1;
  applyVolume();
}

function fadeOutAudio(ms = 500) {
  const token = ++fadeToken;
  const from = fadeGain;
  const started = performance.now();
  const step = () => {
    if (token !== fadeToken) return; // superseded by a newer fade or a cancel
    const t = (performance.now() - started) / ms;
    if (t >= 1 || el.audio.paused) {
      el.audio.pause();
      fadeGain = 1;
      applyVolume();
      return;
    }
    fadeGain = from * (1 - t);
    applyVolume();
    requestAnimationFrame(step);
  };
  step();
}

const REVEAL_FADE_MS = 900; // the tail end of the reveal, not the start of it

let revealFade = null;
// Whether the clip is meant to be audible right now, so a stray click can
// recover from a blocked play() without resurrecting a round that is over.
let wantAudio = false;

function endAudioPhase() {
  clearTimeout(revealFade);
  revealFade = null;
  wantAudio = false;
}

/**
 * The reveal is the payoff -- the answer and the artwork with the song still
 * going. The clip is exactly as long as the round, though, so unless everybody
 * guessed early it has just run out and there is nothing left to hear. Start it
 * again from the top rather than reveal in silence, and save the fade for the
 * end of the window instead of spending it on the first half-second.
 *
 * A clip that has some left but not enough to cover the whole reveal gets
 * restarted too: better to hear the song from the top for the full window than
 * to have it run dry partway through and finish the reveal in silence.
 */
function playRevealAudio(ms) {
  if (!el.audio.src) return;
  clearTimeout(revealFade);
  cancelFade();
  wantAudio = true;

  const left = Number.isFinite(el.audio.duration)
    ? el.audio.duration - el.audio.currentTime
    : Infinity;
  const spent = el.audio.ended || left < ms / 1000;
  if (spent) {
    try { el.audio.currentTime = 0; } catch { /* not seekable yet */ }
  }
  const played = el.audio.play();
  if (played && played.catch) played.catch(() => {});

  revealFade = setTimeout(() => {
    wantAudio = false;
    fadeOutAudio(REVEAL_FADE_MS);
  }, Math.max(0, ms - REVEAL_FADE_MS));
}

/* ------------------------------------------------------------------- rounds */

// A 1x1 transparent GIF. Dropping the artwork by removing `src` leaves the img
// in a broken state, and since the artwork fades out over 0.45s that broken
// glyph is on screen for the whole fade. Point it at nothing-shaped-like-an-
// image instead, once the fade it is mid-way through has finished.
const BLANK_ART = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const ART_FADE_MS = 500; // matches the .viz-face transition, plus a little

let artBlank = null;

/** Let the artwork finish fading out, then let go of the image behind it. */
function releaseArt() {
  clearTimeout(artBlank);
  artBlank = setTimeout(() => {
    artBlank = null;
    el.art.src = BLANK_ART;
  }, ART_FADE_MS);
}

/** Show artwork now, cancelling any pending release of the previous one. */
function setArt(url) {
  clearTimeout(artBlank);
  artBlank = null;
  el.art.src = url;
}

/**
 * Draw the blanked-out title, one box per character.
 *
 * Characters are grouped into words rather than laid out as one long run of
 * flex items -- as a flat list a wrap could fall in the middle of a word and
 * split "KNOW" across two lines, which made the shape of the answer harder to
 * read than the blanks themselves.
 */
function renderMask(mask) {
  el.mask.innerHTML = '';
  if (!mask) return;
  for (const chunk of String(mask).split(' ')) {
    if (!chunk) continue;
    const word = document.createElement('span');
    word.className = 'word';
    for (const ch of chunk) {
      const span = document.createElement('span');
      if (ch === '_') {
        span.className = 'slot';
      } else {
        span.className = 'slot shown';
        span.textContent = ch;
      }
      word.appendChild(span);
    }
    el.mask.appendChild(word);
  }
}

/** The artist line keeps its row whether or not it has content, so the hint
 *  arriving mid-round can't push the visualiser down the page. */
function setMaskArtist(artist) {
  el.maskArtist.textContent = artist ? `by ${artist}` : '';
  el.maskArtist.classList.toggle('on', !!artist);
}

/**
 * The artist hint, wherever it belongs this round.
 *
 * A typing round hangs it under the blanks. Multiple choice has no blanks, so
 * it takes the caption line under the clock -- a fixed-height row that was
 * already saying "pick the song", which means the hint lands without moving
 * anything. Someone sitting the round out keeps the "round in progress" note
 * there instead; the hint is no use to them.
 */
function showArtist(artist) {
  if (!artist) return;
  if (round) round.artist = artist;
  if (!round || round.mode !== 'choice') return setMaskArtist(artist);
  if (!round.spectating) el.sub.textContent = `by ${artist}`;
}

function setSolved(on) {
  el.mask.classList.toggle('solved', on);
  el.answerSlot.classList.toggle('solved', on);
}

/* --------------------------------------------------------------- the cards */

const CHOICE_KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * Draw the four songs. Titles only -- the artist stays a mid-round hint here
 * exactly as it is in a typing round, and printing it on the cards would hand
 * it over before the hint lands.
 *
 * Buttons start disabled: they only mean anything once the clip is playing, and
 * a card pressed during the countdown would be an answer given before the
 * question.
 */
function renderChoices(cards) {
  el.choices.innerHTML = '';
  el.choices.classList.remove('locked');
  el.choices.classList.toggle('hidden', !cards || !cards.length);
  if (!cards) return;

  cards.forEach((card, i) => {
    const btn = document.createElement('button');
    btn.className = 'choice';
    btn.type = 'button';
    btn.dataset.index = i;
    btn.disabled = true;
    btn.innerHTML = '<span class="key"></span><span class="t"></span>';
    btn.querySelector('.key').textContent = CHOICE_KEYS[i] || i + 1;
    btn.querySelector('.t').textContent = card.title;
    btn.addEventListener('click', () => pickChoice(i));
    el.choices.appendChild(btn);
  });
}

function choiceButtons() {
  return [...el.choices.querySelectorAll('.choice')];
}

function setChoicesLive(live) {
  const open = live && round && round.picked == null && !round.spectating;
  for (const btn of choiceButtons()) btn.disabled = !open;
}

/** One card each: the pick is sent once and the row locks behind it. */
function pickChoice(index) {
  if (!round || round.mode !== 'choice' || round.picked != null) return;
  const btn = choiceButtons()[index];
  if (!btn || btn.disabled) return;

  round.picked = index;
  btn.classList.add('picked');
  el.choices.classList.add('locked');
  setChoicesLive(false);
  setSkip(false); // committed to a card -- nothing left to skip
  socket.emit('round:choose', { index });
}

/** Number keys pick a card, so a fast round doesn't come down to mouse aim. */
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!round || round.mode !== 'choice' || round.picked != null) return;
  const active = document.activeElement;
  if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName)) return;
  const n = Number(e.key);
  if (!Number.isInteger(n) || n < 1) return;
  const btn = choiceButtons()[n - 1];
  if (btn && !btn.disabled) {
    e.preventDefault();
    pickChoice(n - 1);
  }
});

/** Send whatever is typed as a guess; the server decides if it counts. */
function submitGuess(input) {
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat:send', { text });
  input.value = '';
}

// Anywhere you start typing, you are typing a guess.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!el.overlay.classList.contains('hidden')) return; // still at the join gate
  const active = document.activeElement;
  if (active === el.chatInput || active === el.guessInput) return;
  if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName)) return;
  if (e.key.length !== 1) return;
  const box = room && room.solo ? el.guessInput : el.chatInput;
  if (box && !box.disabled) box.focus();
});

socket.on('game:loading', ({ message }) => {
  el.lobbyError.textContent = '';
  el.lobbyTitle.textContent = `${message} `;
  const dots = document.createElement('span');
  dots.className = 'loading-dots';
  el.lobbyTitle.appendChild(dots);
});

socket.on('round:prepare', (data) => {
  round = {
    index: data.index,
    total: data.total,
    timeLimit: data.timeLimit,
    startAt: null,
    solved: false,
    mode: data.mode || 'classic',
    picked: null,
    skipped: false,
    // Turned up mid-clip: no audio, no points, and so no card to play either.
    spectating: !!data.rejoin
  };
  showView('play');
  stopClock();
  endAudioPhase();
  cancelFade(); // a reveal fade must not carry into the next round's clip
  el.chatNote.classList.add('hidden');

  // Back to the clock face: drop the reveal state before the next round paints.
  el.vizCenter.classList.remove('reveal', 'has-art');
  releaseArt();
  el.revealTitle.textContent = '';

  el.roundLabel.textContent = `Round ${data.index + 1} / ${data.total}`;
  setTimer('--');
  el.sub.textContent = data.rejoin ? 'round in progress' : 'get ready';
  setStatus(data.rejoin ? 'You joined mid-round — sit this one out.' : '');
  viz.setIdle();
  // Multiple choice has no blanks to fill in -- the answer is on a card, and a
  // masked title would narrow four songs down to one before the clip started.
  el.answerSlot.classList.toggle('hidden', round.mode === 'choice');
  renderMask(data.mask);
  setMaskArtist(null);
  showArtist(data.artist);
  setSolved(false);
  renderChoices(data.choices);
  for (const dot of el.scores.querySelectorAll('.dot')) dot.classList.remove('answered');
  setGuessing(false);

  if (!data.token) return; // rejoined mid-round: no audio for this one

  let told = false;
  const tellReady = () => {
    if (told) return;
    told = true;
    socket.emit('round:ready');
  };
  el.audio.oncanplaythrough = tellReady;
  el.audio.onerror = () => {
    setStatus('Audio failed to load for this round.', 'bad');
    tellReady();
  };
  el.audio.src = `/a/${data.token}`;
  el.audio.load();
  setTimeout(tellReady, 6000); // never hold the room up for one slow client
});

socket.on('round:countdown', ({ in: ms }) => {
  el.sub.textContent = 'starting';
  const end = Date.now() + ms;
  runClock(() => {
    const left = Math.ceil((end - Date.now()) / 1000);
    setTimer(left > 0 ? String(left) : 'GO');
    return left > -1;
  });
});

socket.on('round:start', ({ timeLimit }) => {
  if (!round) return;
  round.startAt = Date.now();
  round.timeLimit = timeLimit;
  // The artist hint owns this line in a picking round once it has landed.
  el.sub.textContent = round.mode !== 'choice'
    ? 'name that song'
    : round.artist ? `by ${round.artist}` : 'pick the song';
  setGuessing(true);
  setChoicesLive(true);

  cancelFade();
  wantAudio = true;
  el.audio.currentTime = 0;
  const played = el.audio.play();
  if (played && played.catch) {
    played.catch(() => setStatus('Tap anywhere to enable audio.', 'bad'));
  }
  viz.resume();

  // One deadline, two readers: the ring interpolates it every frame, the digits
  // round it to whole seconds.
  const end = round.startAt + timeLimit;
  viz.setDeadline(end, timeLimit, 'round');
  runClock(() => {
    const left = end - Date.now();
    setTimer(String(Math.max(0, Math.ceil(left / 1000))));
    el.timer.classList.toggle('urgent', left > 0 && left <= 5000);
    return left > 0;
  });
});

document.addEventListener('click', () => {
  // Recovery path if the browser blocked the first play() call.
  viz.resume();
  if (wantAudio && el.audio.paused && el.audio.src) el.audio.play().catch(() => {});
}, { passive: true });

socket.on('round:answered', ({ correct, points, place, title, artist }) => {
  if (!correct) {
    // Only multiple choice can be wrong and final; a typed miss is just chat.
    setStatus('Locked in — that was not it.', 'bad');
    setChoicesLive(false);
    return;
  }
  if (round) round.solved = true;
  const ordinal = place === 1 ? 'First!' : place === 2 ? 'Second!' : place === 3 ? 'Third!' : 'Got it!';
  setStatus(`${ordinal} +${points} points`, 'good');
  if (title) renderMask(title); // you earned the right to see it
  showArtist(artist);
  setSolved(true);
  // The private-chat note is a typing-round thing: picking a card gives nothing
  // away, so the chat stays open to the room either way.
  const choosing = !!(round && round.mode === 'choice');
  el.chatNote.classList.toggle('hidden', choosing || !!(room && room.solo));
  if (choosing && round.picked != null) {
    const btn = choiceButtons()[round.picked];
    if (btn) btn.classList.add('right');
  }
  setGuessing(false);
  setChoicesLive(false);
});

socket.on('round:hint', ({ mask, artist }) => {
  if (round && round.solved) return; // don't re-hide a title we already showed
  if (mask) renderMask(mask);        // multiple choice sends none
  showArtist(artist);
});

// A private nudge when a guess is nearly right.
socket.on('chat:nudge', ({ text }) => {
  addMessage({ nudge: true, text });
  setStatus(text, 'warm');
});

socket.on('round:progress', ({ pid, answered, of }) => {
  // pid comes from a client's own localStorage, so it is not safe to splice
  // straight into a selector.
  const row = scoreRows.get(pid);
  const dot = row && row.querySelector('.dot');
  if (dot) dot.classList.add('answered');
  if (room && !room.solo && round && !round.solved) {
    setStatus(`${answered} of ${of} have got it`);
  }
});

socket.on('round:reveal', ({ track, results, last, nextIn, correctIndex }) => {
  stopClock();
  playRevealAudio(nextIn);
  el.chatNote.classList.add('hidden');
  setGuessing(false);
  setChoicesLive(false);
  el.timer.classList.remove('urgent');

  // Green on the answer, red on it if that is the card you took.
  if (correctIndex != null) {
    el.choices.classList.add('locked');
    choiceButtons().forEach((btn, i) => {
      if (i === correctIndex) btn.classList.add('right');
      else if (round && round.picked === i) btn.classList.add('wrong');
    });
  }

  // Fill every blank in, so the shape of the answer stays on screen.
  renderMask(track.title);
  setSolved(true);
  setMaskArtist(track.artist);

  // The artwork cross-fades into the same fixed square the clock was using, so
  // the reveal moves nothing. With no artwork we keep the square and put a note
  // glyph in it rather than collapsing the box.
  el.revealTitle.textContent = track.title;
  el.sub.textContent = track.artist;
  if (track.artwork) {
    setArt(track.artwork);
    el.vizCenter.classList.add('has-art');
  } else {
    setTimer('♪', true);
  }
  el.vizCenter.classList.add('reveal');

  const mine = results.find((r) => r.pid === me);
  const got = results.filter((r) => r.correct).length;
  if (mine && mine.correct) setStatus(`Correct — +${mine.points} points`, 'good');
  else if (room && room.solo) setStatus("Didn't get that one.", 'bad');
  else setStatus(`${got} of ${results.length} got it.`, got ? '' : 'bad');

  if (room) {
    room.players = results.map((r) => ({
      ...(room.players.find((p) => p.pid === r.pid) || {}),
      pid: r.pid,
      name: r.name,
      score: r.score,
      answered: r.answered
    }));
    renderScores(room.players);
  }

  // The ring keeps meaning something between rounds -- it counts down to the
  // next one, in a cool colour so it reads as a different clock.
  const label = last ? 'final scores' : 'next round';
  const end = Date.now() + nextIn;
  viz.setDeadline(end, nextIn, 'reveal');
  runClock(() => {
    const left = Math.ceil((end - Date.now()) / 1000);
    if (left <= 0) return false;
    el.roundLabel.textContent = `${label} in ${left}`;
    return true;
  });
});

/** Between games there is nothing to pick and nothing hidden. */
function clearRoundBoard() {
  renderChoices(null);
  setSkip(false);
  el.answerSlot.classList.remove('hidden');
}

/* ------------------------------------------------------------ final screen */

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** A `·`-joined line of small print, built as text so nothing can inject markup. */
function setDotted(node, parts) {
  node.textContent = parts.filter(Boolean).join(' · ');
}

/**
 * The line under each name: how much of the game they actually got. Only the
 * parts that mean something are shown -- "0 firsts" and a one-round streak say
 * nothing, and a row of zeroes reads worse than a shorter line.
 */
function statLine(entry, rounds, solo) {
  const parts = [`${entry.correct}/${rounds} correct`];
  if (!solo && entry.firsts) parts.push(`${entry.firsts} first${entry.firsts === 1 ? '' : 's'}`);
  if (entry.streak > 1) parts.push(`streak ${entry.streak}`);
  if (entry.avgMs != null) parts.push(`avg ${secs(entry.avgMs)}`);
  if (entry.bestMs != null && entry.correct > 1) parts.push(`best ${secs(entry.bestMs)}`);
  return parts;
}

function buildLeaderboard(leaderboard, rounds, solo) {
  assignHues(leaderboard);
  el.leaderboard.innerHTML = '';
  leaderboard.forEach((entry, i) => {
    const li = document.createElement('li');
    li.className = entry.rank === 1 ? 'first' : '';
    li.style.setProperty('--i', i);
    tint(li, entry.pid);
    li.innerHTML = '<span class="rank"></span>'
      + '<span class="who"><span class="nm"></span><span class="stat"></span></span>'
      + '<span class="pts"></span>';
    li.querySelector('.rank').textContent = entry.rank;
    li.querySelector('.nm').textContent = entry.name + (entry.pid === me ? ' (you)' : '');
    // An older server sends no per-player stats; the row still works without them.
    if (entry.correct == null) li.querySelector('.stat').remove();
    else setDotted(li.querySelector('.stat'), statLine(entry, rounds, solo));
    li.querySelector('.pts').textContent = entry.score;
    el.leaderboard.appendChild(li);
  });
}

/** The artwork square, or a note glyph where iTunes had none. */
function songArt(song) {
  const box = document.createElement('span');
  box.className = 'cover';
  if (!song.artwork) {
    box.classList.add('blank');
    box.textContent = '♪';
    return box;
  }
  const img = document.createElement('img');
  img.src = song.artwork;
  img.alt = '';
  img.loading = 'lazy';
  // A dead artwork URL would otherwise leave a broken-image glyph in the row.
  img.addEventListener('error', () => {
    box.classList.add('blank');
    box.textContent = '♪';
  });
  box.appendChild(img);
  return box;
}

/**
 * The right-hand side of a song row: who got it first, and how many managed it.
 *
 * Solo has nobody to compare against, so it reads as a plain result instead of a
 * count -- "solved in 4.2s" rather than "1/1 got it".
 */
function songResult(song, solo) {
  const wrap = document.createElement('span');
  wrap.className = 'who';
  const first = song.solvers[0];

  const line = document.createElement('span');
  if (!first) {
    line.className = 'none';
    line.textContent = solo ? 'missed' : 'nobody got it';
    wrap.appendChild(line);
    return wrap;
  }

  if (solo) {
    line.className = 'first-solver';
    line.textContent = `solved in ${secs(first.ms)}`;
  } else {
    line.className = 'first-solver';
    line.style.setProperty('--hue', hueFor(first.pid));
    const who = document.createElement('span');
    who.className = 'nm';
    who.textContent = first.pid === me ? 'you' : first.name;
    line.appendChild(who);
    const t = document.createElement('span');
    t.className = 'ms';
    t.textContent = secs(first.ms);
    line.appendChild(t);
  }
  wrap.appendChild(line);

  if (!solo) {
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `${song.solvers.length}/${song.eligible} got it`;
    wrap.appendChild(count);
    // Everyone who got it, in the order they got it -- too much for the row, but
    // exactly what you want to check afterwards.
    wrap.title = song.solvers.map((s) => `${s.place}. ${s.name} — ${secs(s.ms)}`).join('\n');
  }
  return wrap;
}

function buildRecap(songs, solo) {
  el.recap.classList.toggle('hidden', !songs.length);
  el.recapList.innerHTML = '';
  if (!songs.length) return;

  songs.forEach((song, i) => {
    const mine = song.solvers.some((s) => s.pid === me);
    const row = document.createElement('div');
    row.className = 'song'
      + (mine ? ' mine' : '')
      + (song.solvers.length ? '' : ' missed');
    row.style.setProperty('--i', i);

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = song.round;
    row.appendChild(num);
    row.appendChild(songArt(song));

    const info = document.createElement('span');
    info.className = 'info';
    const title = document.createElement('span');
    title.className = 't';
    title.textContent = song.title;
    const by = document.createElement('span');
    by.className = 'a';
    setDotted(by, [song.artist, song.year || null]);
    info.appendChild(title);
    info.appendChild(by);
    row.appendChild(info);

    row.appendChild(songResult(song, solo));
    el.recapList.appendChild(row);
  });
}

socket.on('game:over', (summary) => {
  const { leaderboard = [], songs = [], totalRounds } = summary || {};
  const solo = summary.solo != null ? !!summary.solo : !!(room && room.solo);
  const rounds = songs.length || totalRounds || 0;

  stopClock();
  endAudioPhase();
  stopAudio();
  viz.setEmpty();
  round = null;
  clearRoundBoard();

  buildLeaderboard(leaderboard, rounds, solo);
  buildRecap(songs, solo);

  setDotted(el.finalSub, [
    `${rounds} round${rounds === 1 ? '' : 's'}`,
    summary.packName,
    summary.difficultyLabel,
    MODE_LABEL[summary.mode] || null
  ]);

  // The two things a scoreboard cannot show: how many nobody got, and the single
  // quickest answer of the game.
  const notes = [];
  if (summary.missed) notes.push(`${summary.missed} unsolved`);
  if (summary.fastest) {
    const who = solo || summary.fastest.pid === me ? '' : `${summary.fastest.name}, `;
    notes.push(`fastest ${who}${secs(summary.fastest.ms)} — “${summary.fastest.title}”`);
  }
  el.recapSum.textContent = notes.join(' · ');

  // A daily run is filed the moment it finishes, so say plainly whether it
  // landed. `recorded: false` means a run for this account and day was already
  // there -- almost always a second tab -- and the player deserves to know the
  // score they are looking at is not the one on the board.
  el.dailyNote.classList.toggle('hidden', !summary.daily);
  if (summary.daily) {
    el.dailyNote.textContent = summary.daily.recorded
      ? "Your run is on today's leaderboard. Next five songs at midnight UTC."
      : "You'd already finished today's challenge, so this run wasn't counted.";
  }

  showView('final');
});

socket.on('game:reset', () => {
  round = null;
  clearRoundBoard();
  stopClock();
  stopAudio();
  viz.setEmpty();
  lastScore.clear();
  showView('lobby');
  el.lobbyError.textContent = '';
  setStatus('');
});

/* ----------------------------------------------------------------- controls */

el.start.addEventListener('click', () => {
  el.start.disabled = true;
  socket.emit('room:start');
});
el.again.addEventListener('click', () => socket.emit('room:again'));

$('copy-link').addEventListener('click', async (e) => {
  const link = `${location.origin}/r/${CODE}`;
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    const tmp = document.createElement('input');
    tmp.value = link;
    document.body.appendChild(tmp);
    tmp.select();
    document.execCommand('copy');
    tmp.remove();
  }
  e.currentTarget.textContent = 'Copied!';
  setTimeout(() => { e.currentTarget.textContent = 'Copy link'; }, 1600);
});

el.leave.addEventListener('click', () => {
  socket.emit('room:leave');
  location.href = '/';
});

/* --------------------------------------------------------------------- chat */

/*
 * The log carries three different sorts of thing and they need to read
 * differently at a glance: ordinary talk, a solve, and the answer. Joins and
 * leaves are housekeeping and stay out of the way.
 */
function renderSystemMessage(div, msg) {
  if (msg.kind === 'solve') {
    div.className = 'msg solve';
    tint(div, msg.pid);
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.setAttribute('aria-hidden', 'true');
    tick.textContent = '✓';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = msg.name || 'Someone';
    const verb = document.createElement('span');
    verb.className = 'verb';
    verb.textContent = 'got it';
    div.append(tick, nm, verb);
    if (typeof msg.seconds === 'number') {
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = `${msg.seconds.toFixed(1)}s`;
      div.appendChild(time);
    }
    return;
  }

  if (msg.kind === 'answer') {
    div.className = 'msg answer';
    const kicker = document.createElement('div');
    kicker.className = 'kicker';
    kicker.textContent = 'The song was';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = msg.title || '';
    div.append(kicker, title);
    if (msg.artist) {
      const artist = document.createElement('div');
      artist.className = 'artist';
      artist.textContent = `by ${msg.artist}`;
      div.appendChild(artist);
    }
    return;
  }

  // Housekeeping: quiet, small, and out of the way.
  div.className = 'msg sysline';
  const glyph = document.createElement('span');
  glyph.className = 'glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = msg.kind === 'join' ? '→'
    : msg.kind === 'leave' ? '←'
      : msg.kind === 'host' ? '★' : '◈';
  div.appendChild(glyph);

  if (msg.name && msg.text && msg.text.startsWith(msg.name)) {
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = msg.name;
    tint(nm, msg.pid);
    div.appendChild(nm);
    div.appendChild(document.createTextNode(msg.text.slice(msg.name.length).trim()));
  } else {
    div.appendChild(document.createTextNode(msg.text || ''));
  }
}

function addMessage(msg) {
  const nearBottom = el.chatLog.scrollHeight - el.chatLog.scrollTop - el.chatLog.clientHeight < 60;
  const div = document.createElement('div');

  if (msg.nudge) {
    div.className = 'msg nudge';
    div.textContent = msg.text;
  } else if (msg.system) {
    renderSystemMessage(div, msg);
  } else {
    div.className = 'msg' + (msg.private ? ' private' : '');
    tint(div, msg.pid);
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = `${msg.name}: `;
    div.appendChild(who);
    div.appendChild(document.createTextNode(msg.text));
    if (msg.private) {
      const lock = document.createElement('span');
      lock.className = 'lock';
      lock.textContent = 'solvers only';
      div.appendChild(lock);
    }
  }

  el.chatLog.appendChild(div);
  while (el.chatLog.children.length > 200) el.chatLog.removeChild(el.chatLog.firstChild);
  if (nearBottom) el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

socket.on('chat:message', addMessage);

el.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitGuess(el.chatInput);
});

el.guessBar.addEventListener('submit', (e) => {
  e.preventDefault();
  submitGuess(el.guessInput);
});

/**
 * During a live round the chat box is the guess box (skribbl style). Solo
 * players have no sidebar, so they get the standalone bar under the player.
 */
function setGuessing(live) {
  const solo = !!(room && room.solo);
  const solved = !!(round && round.solved);
  // Multiple choice answers with a card, so neither box is a guess box -- the
  // solo bar goes away entirely and the chat stays ordinary chat.
  const choosing = !!(round && round.mode === 'choice');
  const guessing = live && !solved && !choosing;

  el.guessBar.classList.toggle('hidden', !solo || choosing);
  el.guessInput.disabled = !guessing;
  el.guessInput.placeholder = solved ? 'You got it!' : 'Type your guess…';

  el.chatInput.placeholder = guessing
    ? 'Type your guess…'
    : solved && !choosing
      ? 'Chat with the others who got it…'
      : 'Say something…';
  el.chatMode.textContent = guessing ? 'GUESSING' : '';
  el.chatMode.className = guessing ? 'chat-mode-live' : '';

  if (guessing) {
    const box = solo ? el.guessInput : el.chatInput;
    if (document.activeElement !== box) box.focus();
  }

  setSkip(live);
}

/**
 * Giving up on the round. Solo only -- in a room the clock belongs to everyone,
 * so one player cannot cut it short. Offered in both answer modes: a card you
 * have no idea about is as skippable as a title you cannot place.
 */
function setSkip(live) {
  const solo = !!(room && room.solo);
  const answered = !!(round && (round.solved || round.picked != null || round.skipped));
  const can = solo && live && !!round && !answered && !round.spectating;
  // The row itself stays put -- CSS fades the button in and out of it, and
  // hides the row outright in a room that is not solo.
  el.skipRow.classList.toggle('on', can);
  el.skip.disabled = !can;
}

el.skip.addEventListener('click', () => {
  if (!round || round.skipped) return;
  round.skipped = true;
  setSkip(false);
  socket.emit('round:skip');
});

/* ------------------------------------------------------------- first paint */

if (storedPass) el.joinPass.value = storedPass;
el.joinTitle.textContent = 'Join room ' + CODE;
if (el.joinName.value) {
  el.joinSub.textContent = 'Everything is set — one tap lets the browser play audio.';
  el.joinGo.textContent = 'Enter room';
}
setTimeout(() => (el.joinName.value ? el.joinGo : el.joinName).focus(), 50);

/*
 * A daily run needs no name -- it plays under the Discord account, which the
 * server reads off the session cookie and this page cannot influence. The gate
 * itself stays: a click is what earns the browser permission to play audio, and
 * a countdown that starts before the tab is allowed to make a sound would cost
 * the player the first round of a game they only get one shot at.
 */
fetch(`/api/room/${encodeURIComponent(CODE)}`)
  .then((r) => (r.ok ? r.json() : null))
  .then((info) => {
    if (!info || !info.daily || joined) return;
    document.querySelector('label[for="join-name"]').classList.add('hidden');
    el.joinName.classList.add('hidden');
    el.joinTitle.textContent = 'Daily challenge';
    el.joinSub.textContent = "Five songs, thirty seconds each. Tap to start — the clock "
      + 'begins as soon as the first clip loads.';
    el.joinGo.textContent = "Start today's challenge";
    // The code is a private handle on one person's run, not something to pass
    // around, so the top bar names the mode instead of showing it off.
    el.topCode.textContent = 'Daily';
    const back = el.overlay.querySelector('a[href="/"]');
    if (back) {
      back.href = '/daily';
      back.textContent = 'Back to the daily';
    }
    el.joinGo.focus();
  })
  .catch(() => {}); // the ordinary gate still works
