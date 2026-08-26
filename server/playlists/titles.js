'use strict';

/**
 * Tidying track titles that came from a streaming catalogue.
 *
 * Catalogue titles carry release furniture the game must not show: "Hey Jude
 * (Remastered 2015)", "Bad Guy - Single Version". A pack title is the *answer* a
 * player reads at the reveal, and it is what guess.js scores typing against, so
 * the suffix is not merely untidy -- it lands in the answer box.
 *
 * It also hurts resolution. itunes.normalise() strips parentheticals before
 * scoring, but packs.searchTerm() does not: the raw title goes into the search
 * URL, so "(Remastered 2015)" is three junk words handed to Apple's matcher.
 *
 * Deezer publishes `title_short` and needs none of this (see deezer.js). It
 * exists for sources that only give the decorated string.
 *
 * The rule is deliberately conservative -- a suffix is dropped only when it is
 * *recognisably* furniture, because the failure modes are asymmetric. Leaving
 * "(Mono)" on a title is cosmetic; eating the parenthetical in "(I Can't Get No)
 * Satisfaction" or "(Don't Fear) The Reaper" destroys the answer.
 */

/**
 * Words that mark a group as release furniture. At least one must be present --
 * that is what stops a real title like "(The End)" from being read as noise.
 */
const STRONG = new Set([
  'remaster', 'remastered', 'remasters', 'master', 'mastered',
  'mono', 'stereo', 'version', 'mix', 'remix', 'edit', 'edited', 'edition',
  'reissue', 'anniversary', 'deluxe', 'expanded', 'bonus', 'explicit', 'clean',
  'single', 'radio', 'album', 'original', 'take', 'session', 'sessions',
  'acoustic', 'instrumental', 'demo', 'sped', 'slowed', 'remake'
]);

/**
 * Words allowed to keep a STRONG word company. On their own they mean nothing --
 * a group made only of these is left alone.
 */
const FILLER = new Set([
  'the', 'a', 'an', 'of', 'from', 'and', 'with', 'in', 'on', 'at', 'for',
  're', 'digital', 'digitally', 'newly', 'new', 'track', 'recording', 'recorded',
  'us', 'uk', 'international', 'extended', 'club', 'vocal', 'dub', 'alternate',
  'super', 'hd', 'audio', 'stereo'
]);

/** Credit tails, which are furniture whatever follows them. */
const CREDIT_HEAD = /^(?:feat\.?|ft\.?|featuring|w\/|with)\b/i;

const YEAR = /^(?:19|20)\d{2}$/;

/** True when `text` reads as release furniture rather than part of the title. */
function isFurniture(text) {
  const body = String(text || '').trim();
  if (!body) return false;

  // A credit is furniture regardless of the names inside it, which are exactly
  // the words no vocabulary can enumerate.
  if (CREDIT_HEAD.test(body)) return true;

  const words = body.toLowerCase().replace(/[^a-z0-9\s']+/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return false;

  let strong = false;
  for (const word of words) {
    if (STRONG.has(word)) {
      strong = true;
      continue;
    }
    if (FILLER.has(word) || YEAR.test(word)) continue;
    return false; // a word we do not recognise -- assume it is part of the title
  }
  return strong;
}

/** A trailing "(...)" or "[...]" group, captured without its brackets. */
const TRAILING_GROUP = /[([]([^()[\]]*)[)\]]\s*$/;

/**
 * A trailing " - ..." suffix. Spotify's house style, and the reason a
 * parenthetical-only cleaner is not enough: "Creep - Acoustic Version" has no
 * brackets at all. The separator must be a spaced dash, so hyphenated titles
 * ("Jump-Start") and "Ain't-a That Good News" are untouched.
 */
const TRAILING_DASH = /\s+[-–—]\s+([^-–—]*)$/;

/**
 * @param {string} raw a catalogue title
 * @returns {string} the title as a player should see it
 */
function cleanTitle(raw) {
  let title = String(raw || '').replace(/\s+/g, ' ').trim();

  // Loop: real titles carry stacked suffixes -- "Song (Live) (Remastered 2011)".
  // Bounded because each pass must shorten the string, but belt and braces.
  for (let pass = 0; pass < 4; pass++) {
    const group = TRAILING_GROUP.exec(title);
    if (group && isFurniture(group[1])) {
      const shorter = title.slice(0, group.index).trim();
      // Never strip the whole title. "(Mono)" as a complete title is absurd, but
      // returning '' would put a blank answer on screen, which is worse.
      if (shorter) {
        title = shorter;
        continue;
      }
    }

    const dash = TRAILING_DASH.exec(title);
    if (dash && isFurniture(dash[1])) {
      const shorter = title.slice(0, dash.index).trim();
      if (shorter) {
        title = shorter;
        continue;
      }
    }

    break;
  }

  return title;
}

/**
 * The artist as the game should show it.
 *
 * Only whitespace and stray trailing separators are touched. Collaborators are
 * deliberately kept: packs.leadArtist() already reduces a credit to its lead
 * where that matters (iTunes lookups, dedupe keys), and guess.js accepts a
 * partial artist, so trimming the credit here would only make the reveal less
 * informative than the truth.
 */
function cleanArtist(raw) {
  return String(raw || '').replace(/\s+/g, ' ').replace(/[,;&/]+\s*$/, '').trim();
}

module.exports = { cleanTitle, cleanArtist, isFurniture };
