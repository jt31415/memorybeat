/* Front page: pick a mode, hand off to the room page.
 *
 * Deliberately thin. Song packs and playlist import used to live here, and now
 * live in the room lobby instead -- the host picks them there, between games,
 * with everyone watching. Two reasons that is the better home:
 *
 *   - They are the same controls either way, so having both a setup copy and a
 *     lobby copy meant two implementations of one thing, and a lobby that could
 *     only offer whichever half you had already committed to.
 *   - Choosing songs before anyone has joined is the wrong moment. A room is
 *     created, then people arrive, then you decide what to play.
 *
 * So a room is created with a default pack (see packs.defaultSelection) and
 * changed from the lobby.
 */

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

const views = {
  modes: document.getElementById('view-modes'),
  multi: document.getElementById('view-multi')
};

function show(which) {
  for (const [name, el] of Object.entries(views)) el.classList.toggle('hidden', name !== which);
  // A setup panel needs the room the full-size brand was taking.
  document.querySelector('.shell').classList.toggle('setup', which !== 'modes');
}

document.querySelectorAll('[data-open]').forEach((btn) => {
  btn.addEventListener('click', () => {
    show(btn.dataset.open);
    if (btn.dataset.open !== 'multi') return;
    // Straight to whichever field is actually still empty -- a returning player
    // has their name stored and only came back for the code box.
    const name = document.getElementById('mp-name');
    (name.value.trim() ? document.getElementById('mp-code') : name).focus();
  });
});
document.querySelectorAll('[data-back]').forEach((btn) => {
  btn.addEventListener('click', () => show('modes'));
});

/* --------------------------------------------------------------- helpers */

function playerId() {
  let pid = localStorage.getItem('mb:pid');
  if (!pid) {
    pid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('mb:pid', pid);
  }
  return pid;
}

/**
 * No packIds are sent. The server seats a new room on a default pack, and the
 * lobby is where it gets changed -- see server/index.js room:create.
 */
function createRoom(opts, errorEl, button) {
  button.disabled = true;
  errorEl.textContent = '';
  socket.emit('room:create', { ...opts, pid: playerId() }, (res) => {
    if (!res || res.error) {
      button.disabled = false;
      errorEl.textContent = (res && res.error) || 'Something went wrong. Try again.';
      return;
    }
    if (opts.password) sessionStorage.setItem(`mb:pw:${res.code}`, opts.password);
    location.href = `/r/${res.code}`;
  });
}

/* ----------------------------------------------------------------- start */

/* Solo has no setup panel: the mode card is the button. */
document.getElementById('solo-start').addEventListener('click', (e) => {
  const name = localStorage.getItem('mb:name') || 'You';
  localStorage.setItem('mb:name', name);
  createRoom({ solo: true }, document.getElementById('solo-error'), e.currentTarget);
});

const nameInput = document.getElementById('mp-name');
nameInput.value = localStorage.getItem('mb:name') || '';

const codeInput = document.getElementById('mp-code');
const joinError = document.getElementById('mp-join-error');

/**
 * A room code out of whatever was typed or pasted.
 *
 * Room links get shared far more often than bare codes, so a pasted
 * `http://host/r/ABCD` is read as `ABCD` rather than rejected. Codes are letters
 * only (see game.CODE_ALPHABET), which is what makes that safe: everything that
 * is not a letter can be dropped, and the code is whatever is left at the end.
 */
function readCode(raw) {
  const text = String(raw || '').trim().toUpperCase();
  const link = /\/R\/([A-Z]+)/.exec(text);
  const letters = (link ? link[1] : text).replace(/[^A-Z]/g, '');
  return letters.slice(-4);
}

/* Typed codes are uppercased in place and stripped of anything that cannot be in
   one, so the field always shows exactly what would be sent. A pasted link is
   left alone until Join, since rewriting it under the cursor mid-paste is worse
   than letting it sit there for a moment. */
codeInput.addEventListener('input', () => {
  const raw = codeInput.value;
  if (/[/:.]/.test(raw)) return;  // looks like a link; readCode will handle it
  const clean = raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if (clean !== raw) codeInput.value = clean;
  joinError.textContent = '';
});

document.getElementById('mp-join').addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) {
    joinError.textContent = 'Pick a name first.';
    nameInput.focus();
    return;
  }
  const code = readCode(codeInput.value);
  if (code.length !== 4) {
    joinError.textContent = 'A room code is four letters.';
    codeInput.focus();
    return;
  }
  localStorage.setItem('mb:name', name);
  // Whether the room exists, and whether it wants a password, is the room page's
  // question -- it has to ask it on every arrival anyway, since most people get
  // here from a shared link rather than from this box.
  location.href = `/r/${code}`;
});

document.getElementById('mp-create').addEventListener('click', (e) => {
  const name = nameInput.value.trim();
  const errorEl = document.getElementById('mp-error');
  if (!name) {
    errorEl.textContent = 'Pick a name first.';
    nameInput.focus();
    return;
  }
  localStorage.setItem('mb:name', name);
  createRoom(
    {
      solo: false,
      maxPlayers: Number(document.getElementById('mp-max').value) || 8,
      password: document.getElementById('mp-pass').value
    },
    errorEl,
    e.currentTarget
  );
});

/* Enter means "get on with it": the code box joins, and the name box does
   whichever half of the panel the name was typed for -- joining if a code is
   already in, creating if not. */
codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('mp-join').click();
});
nameInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const target = readCode(codeInput.value).length === 4 ? 'mp-join' : 'mp-create';
  document.getElementById(target).click();
});
