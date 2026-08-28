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
  boardEmpty: $('board-empty')
};

let data = null;
let board = 'today';

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

function prettyDate(day) {
  // The day key is already UTC; parsing it back as UTC and formatting in UTC
  // keeps the date on screen the same as the one the challenge is keyed on.
  const date = new Date(`${day}T00:00:00Z`);
  return date.toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC'
  });
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
 */
function paintAction() {
  clear(el.action);

  if (!data.available) {
    el.action.appendChild(node('p', 'hint',
      'The daily challenge is switched off on this server — it needs Discord sign-in configured.'));
    return;
  }

  if (!data.user) return paintSignIn();
  if (data.played) return paintResult();
  if (data.resume) return paintResume();
  return paintPlay();
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
  el.action.appendChild(whoami());

  const button = node('button', 'btn btn-primary btn-block', `Play today's ${data.rounds} songs`);
  button.addEventListener('click', () => start(button, false));
  el.action.appendChild(button);

  el.action.appendChild(node('p', 'hint',
    'Type the title before the clip runs out. One run a day — finishing it locks '
    + 'your score in, so give it your full attention.'));
}

/** A run that was started and walked away from. */
function paintResume() {
  el.action.appendChild(whoami());
  el.action.appendChild(node('p', 'hint',
    "You've got a run in progress. Pick it back up, or throw it away and start "
    + "today's five from the top."));

  const row = node('div', 'daily-buttons');
  const resume = node('button', 'btn btn-primary', 'Resume run');
  resume.addEventListener('click', () => { location.href = `/r/${data.resume}`; });

  const restart = node('button', 'btn', 'Start over');
  restart.addEventListener('click', () => start(restart, true));

  row.append(resume, restart);
  el.action.appendChild(row);
}

/** Already played today: the result, and where it put them. */
function paintResult() {
  const mine = data.played;
  el.action.appendChild(whoami());

  const card = node('div', 'daily-result');
  card.appendChild(stat(String(mine.score), 'points'));
  card.appendChild(stat(`${mine.correct}/${mine.rounds}`, 'correct'));
  card.appendChild(stat(`#${mine.rank}`, `of ${mine.of}`));
  el.action.appendChild(card);

  el.action.appendChild(node('p', 'hint',
    "That's today's run done. The next five songs land when the clock above runs out."));
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

async function start(button, restart) {
  button.disabled = true;
  showError('');
  try {
    const res = await fetch('/api/daily/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restart: !!restart })
    });
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

function paintBoard() {
  const rows = board === 'today' ? data.today : data.allTime;
  clear(el.board);

  el.boardEmpty.classList.toggle('hidden', rows.length > 0);
  el.boardEmpty.textContent = board === 'today'
    ? "Nobody has finished today's challenge yet. Be first."
    : 'No runs recorded yet.';

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

  // The all-time board carries a days count the daily one has no room for and
  // no meaning for -- one row shape, one extra column when there is one.
  li.appendChild(node('span', 'board-meta', board === 'today'
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
