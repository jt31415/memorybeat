'use strict';

/**
 * Pre-resolves pack tracks against the iTunes Search API and writes the results
 * to data/itunes-cache.json.
 *
 *   npm run warm                  # top 150 of each pack
 *   npm run warm -- --limit 400   # go deeper
 *   npm run warm -- --all         # everything (hours, and Apple will throttle)
 *   npm run warm -- --pack decade1980s
 *
 * Not required -- the game resolves tracks on demand -- but running it makes the
 * first "Start game" instant and reports any track the lookup cannot find.
 *
 * Since the packs moved to the database they hold roughly 900 tracks each rather
 * than 120, and warming all ~5,000 at a polite request rate would take hours. So
 * this walks each pack in popularity order and stops at a limit: the songs most
 * likely to be picked for a round get cached first, and the long tail is left to
 * on-demand resolution.
 *
 * Every search in the process shares one queue with a fixed gap between calls,
 * so there is no point running lookups in parallel here. What matters instead
 * is being gentle enough not to get the IP blocked, and giving up quickly if it
 * already is: a blocked IP used to turn this into an hours-long silent hang.
 */

const { allPacks, getPack } = require('./packs');
const {
  resolveTrack,
  resolveCached,
  setSearchGap,
  setThrottleGiveUp,
  searchHealth
} = require('./itunes');

// Wider than the in-game gap. Nobody is watching a loading screen here, and the
// burst rate is what gets an IP blocked in the first place.
const WARM_GAP_MS = 1200;
// Throttles in a row before we call it. The streak resets on any clean
// response, so three in a row past an escalating 2s/4s/8s backoff is already
// conclusive -- and it caps the cost of a blocked IP at ~15s instead of the
// hours this used to spend. There is nothing to lose by stopping: the cache
// keeps what resolved, so a later run picks up where this one left off.
const GIVE_UP_AFTER = 3;

const DEFAULT_LIMIT = 150;

// Unbuffered, so progress is visible when stdout is a pipe rather than a tty.
const say = (line) => process.stderr.write(`${line}\n`);

function parseArgs(argv) {
  const opts = { limit: DEFAULT_LIMIT, pack: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') opts.limit = Infinity;
    else if (argv[i] === '--limit') opts.limit = parseInt(argv[++i], 10) || DEFAULT_LIMIT;
    else if (argv[i] === '--pack') opts.pack = argv[++i];
  }
  return opts;
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  setSearchGap(WARM_GAP_MS);
  setThrottleGiveUp(GIVE_UP_AFTER);

  const packs = opts.pack ? [getPack(opts.pack)].filter(Boolean) : allPacks();
  if (!packs.length) {
    say(opts.pack
      ? `No pack called "${opts.pack}".`
      : 'No packs in the database. Run `npm run build-packs` first.');
    process.exit(1);
  }

  const missing = [];
  let looked = 0;
  let blocked = false;
  let considered = 0;
  let playable = 0;

  for (const pack of packs) {
    // packs.js hands tracks back most-popular-first, so slicing takes the songs
    // most likely to come up in a round.
    const scope = Number.isFinite(opts.limit) ? pack.tracks.slice(0, opts.limit) : pack.tracks;
    considered += scope.length;

    const todo = scope.filter((t) => !resolveCached(t));
    say(`\n${pack.name} -- ${scope.length}/${pack.tracks.length} in scope, ${todo.length} to look up`);
    if (blocked) {
      say('  (skipped, Apple is blocking)');
      continue;
    }

    let done = 0;
    for (const track of todo) {
      const hit = await resolveTrack(track);
      done++;
      looked++;

      // The queue stops itself at GIVE_UP_AFTER; this just notices and reports.
      // Checked before recording a miss, because a track we abandoned has not
      // been shown to be missing -- resolveTrack leaves it uncached to retry.
      const health = searchHealth();
      if (health.givenUp) {
        blocked = true;
        say(`  giving up: ${health.throttleStreak} throttled responses in a row`);
        break;
      }

      if (!hit) missing.push(`${track.title} - ${track.artist}`);
      if (done % 10 === 0 || done === todo.length) say(`  ${done}/${todo.length}`);
    }

    playable += scope.filter((t) => resolveCached(t)).length;
  }

  say('');
  if (blocked) {
    say('Apple is throttling or has blocked this IP -- stopped early.');
    say('Nothing was poisoned; re-run later and it resumes from the cache.');
  }
  if (missing.length) {
    say(`${missing.length} track(s) had no usable preview:`);
    for (const m of missing.slice(0, 40)) say(`  ${m}`);
    if (missing.length > 40) say(`  ... and ${missing.length - 40} more`);
  }
  say(`${playable}/${considered} tracks in scope are playable (${looked} looked up this run).`);

  // The cache is written on a 1s debounce -- let the last write land.
  await new Promise((r) => setTimeout(r, 1500));
  process.exit(blocked ? 1 : 0);
})();
