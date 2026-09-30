/* The daily challenge page: sign in, play once, see where you landed.
 *
 * No socket here. The game itself is an ordinary solo room and happens on
 * /r/CODE like every other game -- this page's whole job is the bit either side
 * of it. It asks the server one question (/api/daily) and paints the answer.
 *
 * Which state it shows is the server's call, not this file's. Whether you have
 * played today is a row in a table on the other end of the wire; asking here
 * and believing the answer is the only version of that check that means
 * anything, since the alternative is trusting a browser not to lie about
 * whether it has already had its go.
 */

const $ = (id) => document.getElementById(id);

const el = {
  date: $('daily-date'),
  clock: $('daily-clock'),
  action: $('daily-action'),
  error: $('daily-error'),
  board: $('board-list'),
  boardEmpty: $('board-empty'),
  boardCaption: $('board-caption')
};

let data = null;
let board = 'today';
let view = 'today'; // whose result the action area shows: 'today' | 'yesterday'

/* ---------------------------------------------------------------- helpers */

/** Text in, element out -- everything user-supplied goes through here. */
function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function clear(parent) {
  while (parent.firstChild) parent.removeChild(parent.firstChild);
}

/**
 * A challenge's date as the viewer would name it: the local date of the moment
 * it went live.
 *
 * Days are keyed on UTC, and in UTC terms a player in California meets the new
 * challenge at 5pm -- labelled with the UTC date, which there is already
 * tomorrow. The moment it went live is a fixed instant, so naming it in local
 * time gives each challenge one stable date per timezone for its whole
 * twenty-four hours: the evening it arrives, for anyone west of Greenwich, and
 * the UTC date itself for anyone east of it.
 */
function localDate(day, options) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, options);
}

function prettyDate(day) {
  return localDate(day, { weekday: 'long', day: 'numeric', month: 'long' });
}

const pad = (n) => String(n).padStart(2, '0');

function countdown(until) {
  const left = Math.max(0, until - Date.now());
  const s = Math.floor(left / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

function showError(message) {
  el.error.textContent = message || '';
}

/* ------------------------------------------------------------- the clock */

/* Ticking to the reset rather than just printing it: "resets in 03:12:44" is
   the number people actually want, and a page left open overnight would
   otherwise sit there claiming a challenge that has already rolled over. */
let clockTimer = null;

function runClock(until) {
  clearInterval(clockTimer);
  const tick = () => {
    el.clock.textContent = countdown(until);
    // Rolled over while the page sat open: reload rather than quietly offering
    // yesterday's challenge and a leaderboard nobody is on any more.
    if (Date.now() >= until) {
      clearInterval(clockTimer);
      location.reload();
    }
  };
  tick();
  clockTimer = setInterval(tick, 1000);
}

/* ------------------------------------------------------------ the action */

/**
 * The one thing this page wants you to do right now.
 *
 * Five possibilities, and they are mutually exclusive by construction -- the
 * server decides which by what it puts in the payload, so this cannot end up
 * showing a Play button to somebody who has already played.
 *
 * Signed in, there is also a look back at yesterday, which is its own view
 * rather than a sixth state: whatever today looks like, yesterday is final.
 */
function paintAction() {
  clear(el.action);

  if (!data.available) {
    el.action.appendChild(node('p', 'hint',
      'The daily challenge is switched off on this server — it needs Discord sign-in configured.'));
    return;
  }

  if (!data.user) return paintSignIn();

  el.action.appendChild(whoami());
  el.action.appendChild(dayTabs());
  if (view === 'yesterday') return paintYesterday();
  if (data.played) return paintResult();
  if (data.resume) return paintResume();
  return paintPlay();
}

/** Today | Yesterday. */
function dayTabs() {
  const row = node('div', 'day-tabs');
  row.setAttribute('role', 'tablist');
  row.setAttribute('aria-label', 'Your results');
  for (const [key, label] of [['today', 'Today'], ['yesterday', 'Yesterday']]) {
    const tab = node('button', 'day-tab', label);
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(view === key));
    tab.addEventListener('click', () => {
      if (view === key) return;
      view = key;
      paintAction();
    });
    row.appendChild(tab);
  }
  return row;
}

function paintSignIn() {
  const why = node('p', 'hint',
    'The daily has one run per person and a global leaderboard, so it needs to know '
    + 'who you are. Signing in shares your Discord name and avatar — nothing else.');

  const button = node('a', 'btn btn-primary btn-block discord-btn', 'Sign in with Discord');
  button.href = `/auth/discord?returnTo=${encodeURIComponent('/daily')}`;

  el.action.append(why, button);
}

function paintPlay() {
  const button = node('button', 'btn btn-primary btn-block', `Play today's ${data.rounds} songs`);
  button.addEventListener('click', () => start(button));
  el.action.appendChild(button);

  el.action.appendChild(node('p', 'hint',
    'Type the title before the clip runs out. One run a day, no restarts — once '
    + "you press play, finishing or leaving locks your score in, so give it your full attention."));
}

/** A run still in progress -- the page was left moments ago. Back in, or it
    gets filed as it stands. There is no starting over. */
function paintResume() {
  el.action.appendChild(node('p', 'hint',
    "You've got a run in progress and the clock is still going. Jump back in "
    + "now — leave it and it's filed with the rounds you've played."));

  const resume = node('button', 'btn btn-primary btn-block', 'Resume run');
  resume.addEventListener('click', () => { location.href = `/r/${data.resume}`; });
  el.action.appendChild(resume);
}

/** Already played today: the result, and where it put them. */
function paintResult() {
  const mine = data.played;
  el.action.appendChild(resultCard(mine));
  // Times only: today's titles are still somebody else's puzzle.
  const rounds = roundList(mine.roundMs, null);
  if (rounds) el.action.appendChild(rounds);
  el.action.appendChild(MBShare.button(data.day, mine));

  el.action.appendChild(node('p', 'hint',
    "That's today's run done. The next five songs land when the clock above runs out."));
}

/** Yesterday: final result if there was one, and the songs either way. */
function paintYesterday() {
  const y = data.yesterday;
  const mine = y.played;

  if (mine) {
    el.action.appendChild(resultCard(mine));
  } else {
    el.action.appendChild(node('p', 'hint', y.songs.length
      ? "You didn't play yesterday's challenge. Here's what you missed:"
      : 'There was no challenge yesterday.'));
  }

  const rounds = roundList(mine ? mine.roundMs : null, y.songs.length ? y.songs : null);
  if (rounds) el.action.appendChild(rounds);
  if (mine) el.action.appendChild(MBShare.button(y.day, mine));
}

function resultCard(mine) {
  const card = node('div', 'daily-result');
  card.appendChild(stat(mine.score.toLocaleString(), 'points'));
  card.appendChild(stat(`${mine.correct}/${mine.rounds}`, 'correct'));
  card.appendChild(stat(`#${mine.rank}`, `of ${mine.of}`));
  return card;
}

/**
 * One row per round: the square, the song when it can be shown, the time.
 *
 * Either input can be missing -- a run from before round times were kept has
 * no times, and today has no songs to show -- and the list is built from
 * whichever is there. Neither means there is nothing to list.
 */
function roundList(roundMs, songs) {
  const count = songs ? songs.length : (roundMs ? roundMs.length : 0);
  if (!count) return null;

  const list = node('ol', 'daily-rounds');
  for (let i = 0; i < count; i++) {
    const li = node('li', 'daily-round');
    li.appendChild(node('span', 'daily-round-n', String(i + 1)));

    const song = songs && songs[i];
    const what = node('span', 'daily-round-song');
    if (song) {
      what.appendChild(node('b', null, song.title));
      what.appendChild(node('span', null, song.artist));
    } else {
      what.appendChild(node('b', null, `Round ${i + 1}`));
    }
    li.appendChild(what);

    if (roundMs) {
      const ms = roundMs[i];
      li.appendChild(node('span', `daily-round-time${ms == null ? ' miss' : ''}`,
        `${MBShare.square(ms)} ${ms == null ? 'miss' : `${(ms / 1000).toFixed(1)}s`}`));
    }
    list.appendChild(li);
  }
  return list;
}

function stat(value, label) {
  const box = node('div', 'daily-stat');
  box.append(node('b', null, value), node('span', null, label));
  return box;
}

/** Who the server thinks you are, with a way to stop being them. */
function whoami() {
  const row = node('div', 'whoami');
  if (data.user.avatar) {
    const img = node('img');
    img.src = data.user.avatar;
    img.alt = '';
    row.appendChild(img);
  }
  row.appendChild(node('span', 'whoami-name', data.user.name));

  const out = node('button', 'btn-ghost', 'Sign out');
  out.addEventListener('click', async () => {
    out.disabled = true;
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } catch { /* signing out locally is the part that matters */ }
    location.reload();
  });
  row.appendChild(out);
  return row;
}

/* --------------------------------------------------------------- playing */

async function start(button) {
  button.disabled = true;
  showError('');
  try {
    const res = await fetch('/api/daily/start', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.code) {
      button.disabled = false;
      showError(body.error || 'Could not start the daily challenge. Try again.');
      // A 409 means somebody finished a run in another tab while this one sat
      // here; repainting shows the score rather than a button that will not work.
      if (res.status === 409) load();
      return;
    }
    location.href = `/r/${body.code}`;
  } catch {
    button.disabled = false;
    showError('Could not reach the server. Check your connection and try again.');
  }
}

/* ---------------------------------------------------------- leaderboards */

const EMPTY_BOARD = {
  today: "Nobody has finished today's challenge yet. Be first.",
  yesterday: "Nobody finished yesterday's challenge.",
  week: 'No runs yet this week. Be first.',
  allTime: 'No runs recorded yet.'
};

/** Boards over one day show a run; boards over many show a total. */
const isDayBoard = (key) => key === 'today' || key === 'yesterday';

function shortDate(day) {
  return localDate(day, { weekday: 'short', day: 'numeric', month: 'short' });
}

/* What span a board covers, where that is not obvious from its name. The week
   is the one that needs it most: "this week" means Monday to Sunday UTC --
   which, named in local time like every other date here, is Sunday to Saturday
   for anyone in the Americas -- and saying when it resets is what makes it
   read as a race. */
function boardCaption() {
  if (board === 'yesterday') return shortDate(data.yesterday.day);
  if (board === 'week') {
    const left = Math.max(0, data.weekResetsAt - Date.now());
    const days = Math.floor(left / 86400000);
    const hours = Math.floor(left / 3600000) % 24;
    const lastDay = new Date(data.weekResetsAt - 86400000).toISOString().slice(0, 10);
    return `${shortDate(data.weekStart)} – ${shortDate(lastDay)} · resets in `
      + (days ? `${days}d ${hours}h` : `${hours}h`);
  }
  return '';
}

function paintBoard() {
  const rows = data.boards[board] || [];
  clear(el.board);

  const caption = boardCaption();
  el.boardCaption.textContent = caption;
  el.boardCaption.classList.toggle('hidden', !caption);

  el.boardEmpty.classList.toggle('hidden', rows.length > 0);
  el.boardEmpty.textContent = EMPTY_BOARD[board];

  const meId = data.user ? data.user.id : null;
  rows.forEach((entry, i) => el.board.appendChild(boardRow(entry, i + 1, entry.id === meId)));
}

function boardRow(entry, rank, isMe) {
  const li = node('li', `board-row${isMe ? ' me' : ''}`);
  li.appendChild(node('span', 'board-rank', `${rank}`));

  const who = node('span', 'board-who');
  if (entry.avatar) {
    const img = node('img');
    img.src = entry.avatar;
    img.alt = '';
    img.loading = 'lazy';
    who.appendChild(img);
  }
  who.appendChild(node('b', null, entry.name));
  li.appendChild(who);

  // The multi-day boards carry a days count the daily ones have no room for and
  // no meaning for -- one row shape, one extra column when there is one.
  li.appendChild(node('span', 'board-meta', isDayBoard(board)
    ? `${entry.correct}/${entry.rounds}`
    : `${entry.days} day${entry.days === 1 ? '' : 's'}`));
  li.appendChild(node('span', 'board-score', entry.score.toLocaleString()));
  return li;
}

document.querySelectorAll('.board-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    board = tab.dataset.board;
    document.querySelectorAll('.board-tab').forEach((other) => {
      other.setAttribute('aria-selected', String(other === tab));
    });
    if (data) paintBoard();
  });
});

/* ------------------------------------------------------------ first paint */

async function load() {
  try {
    const res = await fetch('/api/daily');
    if (!res.ok) throw new Error(`daily returned ${res.status}`);
    data = await res.json();
  } catch {
    showError('Could not load the daily challenge. Refresh to try again.');
    return;
  }

  el.date.textContent = prettyDate(data.day);
  runClock(data.resetsAt);
  paintAction();
  paintBoard();
}

/* An error carried back from the OAuth callback -- it redirects here rather
   than rendering a dead-end page of its own. */
const failure = new URLSearchParams(location.search).get('error');
if (failure) {
  showError(failure.slice(0, 200));
  history.replaceState(null, '', '/daily');
}

load();
