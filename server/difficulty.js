'use strict';

/**
 * Difficulty: which end of a pack a room draws its songs from.
 *
 * Every track carries a `popularity` score (see scripts/build-packs.js), and
 * how widely known a song is is very nearly the definition of how hard it is to
 * name. So difficulty is a preference over that axis -- 0 asks for the songs
 * everybody knows, 100 asks for the long tail.
 *
 * Two things it deliberately is not:
 *
 *   1. **Not a band.** A hard cut ({min, max}) makes every game at the same
 *      setting draw from the same slice of the pack, and hands you nothing but
 *      that slice -- a night of "Tricky" would never once throw up a song
 *      everyone can shout at the screen. Instead each track gets a *weight* and
 *      the whole pack is shuffled by it, so the setting shifts where the songs
 *      come from without ever fencing anything off.
 *
 *   2. **Not a weight that reaches zero.** Every track keeps at least FLOOR of
 *      the weight of a perfectly on-target one, so the most obscure song in the
 *      pack is always in play, just rarely. In a ten-round game that works out
 *      at roughly one or two songs from outside the chosen band -- enough that
 *      the mix feels alive rather than sorted.
 *
 * Positions are worked out *within the pack*, not against the raw 0..100 score,
 * because the packs are not comparable on the raw scale: All Time is by
 * construction the top 150 of every decade, so almost none of it scores below
 * 60, while a genre pack from Last.fm tags has a long thin tail. Ranking inside
 * the pack means the slider always spans that pack's own range, and "Deep cuts"
 * means the deep cuts of whatever you picked.
 */

const crypto = require('crypto');

/**
 * Default is deliberately on the easy side of the middle rather than at 50.
 * Song choice used to be a flat shuffle of the pack, but only tracks already in
 * the iTunes cache can start a game promptly, and `npm run warm` fills that
 * cache in popularity order -- so in practice the game has always played the
 * recognisable end of a pack. 25 is about where that lands, so an existing room
 * that never touches the slider plays roughly the game it played before.
 */
const DEFAULT_DIFFICULTY = 25;

/**
 * Named stops along the slider. The slider itself is continuous; these are for
 * telling the player what they just picked, and the client reads them from
 * /api/difficulty rather than keeping its own copy.
 */
const LEVELS = [
  { upTo: 12, name: 'Chart toppers', blurb: 'wall-to-wall hits' },
  { upTo: 37, name: 'Easy', blurb: 'big, familiar songs' },
  { upTo: 62, name: 'Balanced', blurb: 'a bit of everything' },
  { upTo: 87, name: 'Tricky', blurb: 'past the obvious hits' },
  { upTo: 100, name: 'Deep cuts', blurb: "the pack's long tail" }
];

/**
 * Width of the band, in pack-percentile points. At 16 the weighting is a clear
 * preference rather than a filter: a song 30 points off target is still picked
 * about a sixth as often as one dead centre, so neighbouring settings overlap
 * and moving the slider a notch shifts the mix instead of replacing it.
 */
const SIGMA = 16;

/**
 * Floor weight, as a fraction of an on-target track's. This is the variety
 * guarantee, and the number is chosen for what it does to a ten-round game
 * rather than for looking tidy: against a ~360-track effective band in a
 * 900-track pack, 0.08 of the remainder is around a seventh of the total
 * weight, so most games get a song or two from outside the band and no game is
 * ever a clean sweep of one slice. Near the ends of the slider half the band
 * falls off the edge of the pack, so the share of wildcards roughly doubles --
 * which is the right way round: "Deep cuts" should still hand you a hit
 * occasionally, and it is the setting most likely to run into tracks iTunes
 * cannot resolve.
 */
const FLOOR = 0.08;

/** A float in the open interval (0, 1) -- log(0) would poison the sort key. */
function random01() {
  return (crypto.randomInt(2 ** 32) + 1) / (2 ** 32 + 1);
}

function clampDifficulty(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_DIFFICULTY;
  return Math.min(100, Math.max(0, n));
}

function levelFor(difficulty) {
  const d = clampDifficulty(difficulty);
  return LEVELS.find((level) => d <= level.upTo) || LEVELS[LEVELS.length - 1];
}

/** What the lobby and the chat line say about a setting. */
function describe(difficulty) {
  const d = clampDifficulty(difficulty);
  const level = levelFor(d);
  return { value: d, name: level.name, blurb: level.blurb };
}

/*
 * Ease is the position of a track within its own pack: 100 for the
 * best-known song in it, 0 for the least. It is an *ordinal* rank rather than
 * the popularity score itself, which matters because ties are everywhere --
 * before anyone runs the Last.fm enrichment pass, popularity comes from
 * Billboard year-end position, which gives ~5,000 tracks only 100 distinct
 * values. Ranking spreads those ties evenly across the axis instead of piling
 * hundreds of tracks onto one point of the slider.
 *
 * Cached against the track array itself: a pack's tracks are read once per
 * process (see packs.js), so this sorts each pack once no matter how many rooms
 * and games use it, and a packs.reload() hands over fresh arrays that miss the
 * cache naturally.
 */
const easeCache = new WeakMap();

function easeScale(tracks) {
  const cached = easeCache.get(tracks);
  if (cached) return cached;

  // Unscored tracks sort last: a missing popularity means no signal at all, and
  // the tracks that have one are the ones we can honestly call recognisable.
  const byPopularity = tracks.map((_, i) => i).sort((a, b) => {
    const pa = tracks[a].popularity;
    const pb = tracks[b].popularity;
    if (pa == null && pb == null) return a - b;
    if (pa == null) return 1;
    if (pb == null) return -1;
    return pb - pa || a - b;
  });

  const ease = new Float64Array(tracks.length);
  const span = Math.max(1, tracks.length - 1);
  byPopularity.forEach((index, rank) => {
    ease[index] = 100 * (1 - rank / span);
  });
  easeCache.set(tracks, ease);
  return ease;
}

/** Where on the ease axis a setting is aiming. */
function targetEase(difficulty) {
  return 100 - clampDifficulty(difficulty);
}

/** A bell around the target, lifted off zero so nothing is ever excluded. */
function weightAt(ease, target) {
  const z = (ease - target) / SIGMA;
  return FLOOR + (1 - FLOOR) * Math.exp(-0.5 * z * z);
}

/**
 * The whole pack, shuffled so that songs near the chosen difficulty tend to
 * come first -- a weighted random permutation, not a filter and not a sort.
 *
 * Returning the *whole* pack is what keeps this compatible with how a game
 * actually picks songs: game.js hands the ordered list to the resolver, which
 * walks it and takes the first ten tracks it can get a preview clip for. A
 * track the difficulty setting does not want is not removed, just pushed back
 * far enough that it is only reached when the wanted ones run out (a small
 * pack, a cold cache, or an obscure setting where iTunes has nothing for half
 * the candidates). A game that drifts a little easier than asked beats a short
 * game.
 *
 * The weighting itself is Efraimidis-Spirakis: give each item the key
 * -ln(U)/weight and sort ascending. That yields a permutation drawn exactly as
 * if the items had been picked one at a time without replacement, in proportion
 * to their weights -- so the ten songs a game ends up with are a genuine
 * weighted sample, and every one of the other ~890 had a real chance at each
 * slot.
 *
 * @param {Array} tracks    a pack's tracks (any order)
 * @param {number} difficulty 0 (best known) .. 100 (deepest cuts)
 * @param {() => number} [random] source of floats in (0, 1); injectable for tests
 */
function weightedOrder(tracks, difficulty, random = random01) {
  if (!Array.isArray(tracks) || tracks.length < 2) return (tracks || []).slice();

  const ease = easeScale(tracks);
  const target = targetEase(difficulty);

  return tracks
    .map((track, i) => ({ track, key: -Math.log(random()) / weightAt(ease[i], target) }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.track);
}

/**
 * A plain, unweighted shuffle -- every track equally likely in every slot.
 *
 * For pools where difficulty is meaningless: an imported playlist (see
 * packs.registerImport). This is not the same as calling weightedOrder() on a
 * pool with no popularity scores, and the difference is a trap worth spelling
 * out. easeScale() sorts unscored tracks *last*, so when nothing has a score its
 * comparator falls through to `a - b` and ease becomes a clean 100..0 gradient
 * down the array. The weighting would then be perfectly real and aimed at
 * nothing but array position -- "Deep cuts" would hand you the bottom of the
 * playlist and call it obscurity. Silent, and wrong in a way that looks right.
 *
 * Fisher-Yates rather than the keyed sort weightedOrder uses: with equal weights
 * the two are equivalent in distribution, and this one is obviously uniform to
 * anybody reading it.
 */
function uniformOrder(tracks) {
  if (!Array.isArray(tracks) || tracks.length < 2) return (tracks || []).slice();

  const out = tracks.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

module.exports = {
  DEFAULT_DIFFICULTY,
  LEVELS,
  SIGMA,
  FLOOR,
  clampDifficulty,
  describe,
  levelFor,
  easeScale,
  targetEase,
  weightAt,
  weightedOrder,
  uniformOrder
};
