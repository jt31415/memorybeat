/*
 * Player colours.
 *
 * Twelve hues, bright enough to carry dark text and to read as a dot on the
 * ink ground. A player's hue is derived from their id, so it follows them
 * across rounds and sessions rather than being reshuffled on every render.
 */
export const PLAYER_HUES = [
  '#B6F06A', '#7FB2FF', '#FF9BD2', '#FFB057',
  '#FFD36B', '#6BE38F', '#2FE0C8', '#FF4D6D',
  '#9FE8FF', '#F5F1EA', '#FF7A2F', '#D7C4A3'
];

function hueIndex(pid) {
  const s = String(pid || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % PLAYER_HUES.length;
}

/**
 * pid -> colour for everyone in the room.
 *
 * Preferred hue first, then walk to the next free one, so two people in the
 * same room never share a colour (up to twelve of them) and everybody keeps
 * their own as long as they stay. Sorted by id so the assignment is stable
 * rather than dependent on the score order it arrives in.
 */
export function assignHues(players) {
  const byPid = new Map();
  const taken = new Set();
  const spill = [];
  const ordered = [...(players || [])].sort((a, b) => (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0));

  for (const p of ordered) {
    const want = hueIndex(p.pid);
    if (taken.has(want)) spill.push(p);
    else {
      taken.add(want);
      byPid.set(p.pid, want);
    }
  }
  for (const p of spill) {
    const want = hueIndex(p.pid);
    let placed = want; // >12 players: duplicates are fine
    for (let k = 1; k <= PLAYER_HUES.length; k++) {
      const j = (want + k) % PLAYER_HUES.length;
      if (!taken.has(j)) {
        placed = j;
        break;
      }
    }
    taken.add(placed);
    byPid.set(p.pid, placed);
  }
  return byPid;
}

/** A hue lookup over an assignment, falling back to the id's own preference
 *  for anybody who has already left the room. */
export function hueLookup(assignment) {
  return (pid) => PLAYER_HUES[assignment.has(pid) ? assignment.get(pid) : hueIndex(pid)];
}
