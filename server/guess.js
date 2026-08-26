'use strict';

/**
 * Judging typed guesses against a song title.
 *
 * Players type free text, so this has to be generous about punctuation,
 * accents, "feat." clutter and ordinary typos, while still refusing a guess
 * that is merely in the same postcode as the answer.
 */

/** Strip a string down to comparable letters and digits. */
function norm(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Same, but with anything in brackets removed first. */
function stripBrackets(str) {
  return String(str || '').replace(/\(.*?\)|\[.*?\]/g, ' ');
}

/** Just the contents of the first bracketed group, if any. */
function bracketContent(str) {
  const m = String(str || '').match(/\((.*?)\)|\[(.*?)\]/);
  return m ? m[1] || m[2] || '' : '';
}

const compact = (s) => s.replace(/ /g, '');

const dropLeadingThe = (s) => s.replace(/^the /, '');

const dropFeat = (s) => s.replace(/\b(feat|ft|featuring|with)\b.*$/, '').trim();

/**
 * Every spelling of a title we are willing to accept.
 * e.g. "ily (i love you baby)" accepts "ily", "ily i love you baby" and
 * "i love you baby".
 */
function acceptedForms(title) {
  const forms = new Set();
  const add = (value) => {
    const n = dropFeat(norm(value));
    if (!n) return;
    forms.add(n);
    const noThe = dropLeadingThe(n);
    if (noThe) forms.add(noThe);
  };

  add(title);
  add(stripBrackets(title));
  const inner = bracketContent(title);
  if (inner) add(inner);
  return [...forms];
}

/** Levenshtein distance, capped so a pathological input can't cost anything. */
function distance(a, b) {
  if (a === b) return 0;
  a = a.slice(0, 64);
  b = b.slice(0, 64);
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * How many characters a guess may be off by. Short titles get no slack --
 * "Roar" and "Rain" are two edits apart and are different songs.
 */
function tolerance(len) {
  if (len <= 5) return 0;
  if (len <= 10) return 1;
  if (len <= 16) return 2;
  return 3;
}

/**
 * @returns {'correct'|'close'|'artist'|'no'}
 *   correct - award the points
 *   close   - right track, wrong spelling; nudge the guesser privately
 *   artist  - they named the artist instead of the song
 */
function judge(guess, track) {
  const g = dropFeat(norm(guess));
  if (!g) return 'no';

  const forms = acceptedForms(track.title);

  for (const form of forms) {
    if (g === form) return 'correct';
    if (compact(g) === compact(form)) return 'correct';
    const slack = tolerance(form.length);
    if (slack > 0 && distance(g, form) <= slack) return 'correct';
    // Spacing differences shouldn't eat the typo budget ("bad guy"/"badguy").
    if (slack > 0 && distance(compact(g), compact(form)) <= slack) return 'correct';
  }

  // Naming the artist is a common near-miss worth its own nudge. "The" is
  // optional on both sides -- "the weeknd" and "weeknd" are the same answer.
  const artistForms = new Set();
  for (const base of [norm(track.artist), dropFeat(norm(track.artist))]) {
    if (!base) continue;
    artistForms.add(base);
    artistForms.add(dropLeadingThe(base));
  }
  const guessForms = [g, dropLeadingThe(g)];
  for (const form of artistForms) {
    for (const gf of guessForms) {
      if (gf === form || distance(gf, form) <= tolerance(form.length)) return 'artist';
    }
  }

  // "Close" is a slightly wider net than "correct" -- but only slightly, and
  // only on titles long enough for the distance to mean something. Two
  // unrelated six-letter songs are often three edits apart, and telling
  // someone they are warm when they are not is worse than saying nothing.
  if (g.length >= 4) {
    for (const form of forms) {
      if (form.length < 6) continue;
      const near = tolerance(form.length) + 1;
      if (distance(g, form) <= near || distance(compact(g), compact(form)) <= near) {
        return 'close';
      }
    }
  }
  return 'no';
}

/**
 * The blanked-out title players see, with `revealed` character indexes filled
 * in. Letters and digits become "_"; spaces and punctuation stay put so the
 * shape of the title is a hint in itself.
 */
function maskTitle(title, revealed = new Set()) {
  return [...String(title)]
    .map((ch, i) => {
      if (!/[a-z0-9]/i.test(ch)) return ch;
      return revealed.has(i) ? ch : '_';
    })
    .join('');
}

/** Character indexes in a title that a hint could reveal. */
function revealableIndexes(title) {
  const out = [];
  [...String(title)].forEach((ch, i) => {
    if (/[a-z0-9]/i.test(ch)) out.push(i);
  });
  return out;
}

module.exports = { judge, norm, distance, acceptedForms, maskTitle, revealableIndexes };
