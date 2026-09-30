/* Small formatting helpers shared by every page. */

const pad = (n) => String(n).padStart(2, '0');

/** HH:MM:SS until a moment, floored at zero. */
export function countdown(until, now = Date.now()) {
  const s = Math.floor(Math.max(0, until - now) / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

export const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

export const num = (n) => Number(n || 0).toLocaleString('en-US');

export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/**
 * A challenge's date as the viewer would name it: the local date of the moment
 * it went live.
 *
 * Days are keyed on UTC, and in UTC terms a player in California meets the new
 * challenge at 5pm -- labelled with the UTC date, which there is already
 * tomorrow. The moment it went live is a fixed instant, so naming it in local
 * time gives each challenge one stable date per timezone for its whole
 * twenty-four hours.
 */
export function localDate(day, options) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, options);
}

/** When the next daily lands -- midnight UTC -- as a local clock time. */
export function nextDailyAt() {
  const now = new Date();
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return reset.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** The first letter of a name, for the round avatars. */
export function initial(name) {
  const ch = [...String(name || '').trim()][0];
  return ch ? ch.toUpperCase() : '?';
}

/**
 * A room code out of whatever was typed or pasted.
 *
 * Room links get shared far more often than bare codes, so a pasted
 * `http://host/r/ABCD` is read as `ABCD` rather than rejected. Codes are letters
 * only (see game.CODE_ALPHABET), which is what makes that safe: everything that
 * is not a letter can be dropped, and the code is whatever is left at the end.
 */
export function readCode(raw) {
  const text = String(raw || '').trim().toUpperCase();
  const link = /\/R\/([A-Z]+)/.exec(text);
  const letters = (link ? link[1] : text).replace(/[^A-Z]/g, '');
  return letters.slice(-4);
}
