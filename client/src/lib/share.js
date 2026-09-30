/* The daily's share line, and getting it onto the clipboard.
 *
 * Shared by the daily page and the room's final screen, so the line someone
 * copies straight after finishing is the same line they would copy from the
 * daily page an hour later.
 *
 *   MemoryBeat Daily · Thu Sep 24
 *   🟩 3.2s 🟩 7.8s 🟨 14.1s 🟥 — 🟩 2.4s
 *   4/5 · 3,812 pts · #12 of 87
 *   https://example.com/daily
 */

/* A round's square. Ten seconds is a third of the clock: under it you knew
   the song, over it you worked it out. */
export const FAST_MS = 10000;

/** 'fast' | 'slow' | 'miss' -- the same split the squares make, for the page. */
export function speed(ms) {
  if (ms == null) return 'miss';
  return ms < FAST_MS ? 'fast' : 'slow';
}

export function square(ms) {
  return { fast: '🟩', slow: '🟨', miss: '🟥' }[speed(ms)];
}

/* Local date of the moment the challenge went live, like the daily page's
   header -- so the line someone shares carries the date they saw on screen. */
function shortDate(day) {
  return new Date(`${day}T00:00:00Z`)
    .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    .replace(',', '');
}

/**
 * @param {string} day     'YYYY-MM-DD'
 * @param {object} result  { score, correct, rounds, rank, of, roundMs }
 *                         roundMs is null for runs filed before it was kept,
 *                         in which case the rounds line is left out.
 */
export function shareText(day, result) {
  const lines = [`MemoryBeat Daily · ${shortDate(day)}`];
  if (Array.isArray(result.roundMs)) {
    lines.push(result.roundMs
      .map((ms) => `${square(ms)} ${ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`}`)
      .join(' '));
  }
  lines.push(`${result.correct}/${result.rounds} · ${Number(result.score).toLocaleString('en-US')} pts`
    + ` · #${result.rank} of ${result.of}`);
  lines.push(`${location.origin}/daily`);
  return lines.join('\n');
}

/* The async clipboard API only exists on secure origins, and a server reached
   at http://<ip>:<port> is not one -- so the old select-and-copy route stays
   as the fallback rather than as dead code. */
export async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch { /* fall through to the old way */ }
  }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch { /* nothing left to try */ }
  area.remove();
  return ok;
}
