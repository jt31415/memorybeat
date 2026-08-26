'use strict';

/**
 * Populates the song database.
 *
 *   npm run build-packs                 # everything it can
 *   npm run build-packs -- --decades    # Billboard decade packs only
 *   npm run build-packs -- --genres     # Last.fm genre packs only
 *   npm run build-packs -- --score      # just recompute popularity
 *   npm run build-packs -- --decades --from 2000
 *
 * Decade packs come from the Billboard Year-End Hot 100 pages on Wikipedia, one
 * page per year. Genre packs come from Last.fm tags. Both need only public
 * endpoints, but Last.fm wants a free API key in LASTFM_API_KEY.
 *
 * Safe to re-run: tracks are upserted on their cache key and each pack's
 * membership is rewritten, so a second run repairs rather than duplicates.
 */

// Before anything reads process.env: LASTFM_API_KEY normally lives in .env.
require('../server/env');

const db = require('../server/db');
const { trackKey, dedupeKey, leadArtist } = require('../server/packs');
const { yearEndHot100 } = require('./sources/wikipedia');
const lastfm = require('./sources/lastfm');

const say = (line) => process.stderr.write(`${line}\n`);

/* --------------------------------------------------------------- what to build */

const DECADES = [
  { start: 1970, id: 'decade1970s', name: '70s', icon: '70s', blurb: 'Disco, soul and stadium rock.' },
  { start: 1980, id: 'decade1980s', name: '80s', icon: '80s', blurb: 'Synths, hair and drum machines.' },
  { start: 1990, id: 'decade1990s', name: '90s', icon: '90s', blurb: 'Grunge, R&B and boy bands.' },
  { start: 2000, id: 'decade2000s', name: '00s', icon: '00s', blurb: 'Ringtone rap and TRL pop.' },
  { start: 2010, id: 'decade2010s', name: '10s', icon: '10s', blurb: 'The streaming era arrives.' },
  { start: 2020, id: 'decade2020s', name: '20s', icon: '20s', blurb: 'Everything inescapable since 2020.' }
];

/*
 * Genre packs. Several tags per pack, merged: a single Last.fm tag is noisy, and
 * the union of two or three related tags is a much better picture of a genre
 * than any one of them. `limit` is per tag.
 */
const GENRES = [
  { id: 'genrePop',       name: 'Pop',       icon: 'POP', tags: ['pop', 'dance pop'],                     limit: 250, blurb: 'Chart pop, across eras.' },
  { id: 'genreRap',       name: 'Rap',       icon: 'RAP', tags: ['hip-hop', 'rap', 'hip hop'],            limit: 200, blurb: 'Hip-hop and rap, from the classics to now.' },
  { id: 'genreKpop',      name: 'K-Pop',     icon: 'K',   tags: ['k-pop', 'kpop', 'korean'],              limit: 200, blurb: 'Korean pop, idols and all.' },
  { id: 'genreClassical', name: 'Classical', icon: 'CLA', tags: ['classical', 'baroque', 'romantic'],     limit: 200, blurb: 'The standard repertoire, orchestral and solo.' },
  { id: 'genreEdm',       name: 'EDM',       icon: 'EDM', tags: ['edm', 'electronic', 'house', 'trance'], limit: 250, blurb: 'Festival main-stage anthems, drops and all.' }
];

/*
 * The flagship pack: the most recognisable songs of every decade, together.
 *
 * PER_DECADE deliberately matches `npm run warm`'s default limit. Warm resolves
 * the top N of each pack in popularity order, and this pack is assembled from
 * exactly that selection using exactly that ordering -- so warming the decades
 * warms this pack too, for free, and it plays instantly from a cold-ish cache.
 * Change one of these numbers and you should change the other.
 */
const ALL_TIME = {
  id: 'allTime',
  name: 'All Time',
  icon: 'ALL',
  blurb: 'The biggest songs of every decade since the 70s.',
  perDecade: 150
};

/* ----------------------------------------------------------------- upserting */

/**
 * Insert or update one track, returning its row id.
 *
 * The unique key is trackKey (title|artist lowercased) because that is what the
 * preview cache is keyed on -- keeping them one-to-one means a rebuild never
 * strands resolved audio. dedupeKey is recorded alongside it so near-duplicates
 * can be collapsed by the caller.
 */
function makeUpsert(conn) {
  const insert = conn.prepare(`
    INSERT INTO tracks (title, artist, track_key, dedupe_key, first_year, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (track_key) DO UPDATE SET
      updated_at = excluded.updated_at,
      first_year = MIN(COALESCE(tracks.first_year, excluded.first_year), COALESCE(excluded.first_year, tracks.first_year))
  `);
  const find = conn.prepare('SELECT id FROM tracks WHERE track_key = ?');

  return function upsert(title, artist, year) {
    const key = trackKey({ title, artist });
    const now = Date.now();
    insert.run(title, artist, key, dedupeKey(title, artist), year ?? null, now, now);
    return find.get(key).id;
  };
}

function writePack(conn, meta, rows) {
  conn.prepare(`
    INSERT INTO packs (id, name, blurb, icon, kind, sort, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name, blurb = excluded.blurb, icon = excluded.icon,
      kind = excluded.kind, sort = excluded.sort, source = excluded.source,
      updated_at = excluded.updated_at
  `).run(meta.id, meta.name, meta.blurb, meta.icon, meta.kind, meta.sort, meta.source, Date.now());

  // Rewrite membership wholesale: a track dropped from the source upstream
  // should disappear here too, and that is cheaper to reason about than a diff.
  conn.prepare('DELETE FROM pack_tracks WHERE pack_id = ?').run(meta.id);
  const link = conn.prepare(
    'INSERT OR IGNORE INTO pack_tracks (pack_id, track_id, rank, year) VALUES (?, ?, ?, ?)'
  );
  for (const row of rows) link.run(meta.id, row.trackId, row.rank ?? null, row.year ?? null);
}

/* ------------------------------------------------------------ decade packs */

async function buildDecades(conn, opts) {
  const upsert = makeUpsert(conn);
  const thisYear = new Date().getFullYear();
  let built = 0;

  for (const decade of DECADES) {
    const years = [];
    for (let y = decade.start; y < decade.start + 10 && y <= thisYear; y++) {
      if (opts.from && y < opts.from) continue;
      years.push(y);
    }
    if (!years.length) continue;

    say(`\n${decade.name} (${years[0]}-${years[years.length - 1]})`);

    // dedupeKey -> row, so a song that charted in three consecutive years is
    // one entry holding its best rank rather than three near-identical ones.
    const picked = new Map();
    const gotYears = [];   // years that actually returned a chart
    let scraped = 0;
    let skipped = 0;
    let missingYears = 0;

    for (const year of years) {
      let entries;
      try {
        entries = await yearEndHot100(year);
      } catch (err) {
        say(`  ${year}: ${err.message}`);
        continue;
      }
      if (!entries.length) {
        missingYears++;
        continue;
      }
      gotYears.push(year);
      scraped += entries.length;
      skipped += Math.max(0, 100 - entries.length);

      for (const entry of entries) {
        const dk = dedupeKey(entry.title, entry.artist);
        const existing = picked.get(dk);
        if (existing) {
          existing.years++;
          if (entry.rank < existing.rank) {
            existing.rank = entry.rank;
            existing.year = entry.year;
          }
          continue;
        }
        picked.set(dk, {
          title: entry.title,
          artist: entry.artist,
          rank: entry.rank,
          year: entry.year,
          years: 1
        });
      }
      say(`  ${year}: ${entries.length} tracks`);
    }

    if (!picked.size) {
      say('  nothing scraped, leaving this pack alone');
      continue;
    }

    const chart = conn.prepare(`
      UPDATE tracks SET billboard_best = MIN(COALESCE(billboard_best, 9999), ?),
                        billboard_years = MAX(COALESCE(billboard_years, 0), ?),
                        updated_at = ?
       WHERE id = ?
    `);

    const rows = db.transaction(conn, () => {
      const out = [];
      for (const t of picked.values()) {
        const trackId = upsert(t.title, t.artist, t.year);
        chart.run(t.rank, t.years, Date.now(), trackId);
        out.push({ trackId, rank: t.rank, year: t.year });
      }
      out.sort((a, b) => a.rank - b.rank);

      writePack(conn, {
        id: decade.id,
        name: decade.name,
        blurb: decade.blurb,
        icon: decade.icon,
        kind: 'decade',
        sort: decade.start,
        // Name the years we actually got, not the ones we asked for -- the
        // current decade is still partly in the future.
        source: `Wikipedia: Billboard Year-End Hot 100 ${gotYears[0]}-${gotYears[gotYears.length - 1]}`
      }, out);
      return out;
    });

    built++;
    const notes = [];
    if (skipped) notes.push(`${skipped} unusable row(s) on Wikipedia`);
    if (missingYears) notes.push(`${missingYears} year(s) with no page yet`);
    say(`  => ${rows.length} unique tracks from ${scraped} chart entries`
      + (notes.length ? ` (${notes.join(', ')})` : ''));
  }
  return built;
}

/* ------------------------------------------------------------- genre packs */

async function buildGenres(conn) {
  const upsert = makeUpsert(conn);
  let built = 0;

  for (const genre of GENRES) {
    say(`\n${genre.name}`);
    const picked = new Map();

    for (const tag of genre.tags) {
      let tracks;
      try {
        tracks = await lastfm.tagTopTracks(tag, genre.limit);
      } catch (err) {
        say(`  tag "${tag}": ${err.message}`);
        continue;
      }
      let added = 0;
      for (const t of tracks) {
        const dk = dedupeKey(t.title, t.artist);
        if (picked.has(dk)) continue;
        picked.set(dk, { title: t.title, artist: t.artist, rank: picked.size + 1 });
        added++;
      }
      say(`  tag "${tag}": ${tracks.length} tracks, ${added} new`);
    }

    if (!picked.size) {
      say('  nothing returned, leaving this pack alone');
      continue;
    }

    const rows = db.transaction(conn, () => {
      const out = [];
      for (const t of picked.values()) {
        out.push({ trackId: upsert(t.title, t.artist, null), rank: t.rank, year: null });
      }
      writePack(conn, {
        id: genre.id,
        name: genre.name,
        blurb: genre.blurb,
        icon: genre.icon,
        kind: 'genre',
        // Genres sort after every decade.
        sort: 3000 + GENRES.indexOf(genre),
        source: `Last.fm tags: ${genre.tags.join(', ')}`
      }, out);
      return out;
    });

    built++;
    say(`  => ${rows.length} unique tracks`);
  }
  return built;
}

/* ------------------------------------------------------------ all-time pack */

/**
 * Assemble the All Time pack from the decade packs already in the database.
 *
 * Pure SQL, no network: it is a view over data the decade build already
 * produced. Must run *after* scoring, because "top N" means top by popularity
 * and a stale score would pick the wrong songs.
 *
 * A song that charted either side of a decade boundary can be in two decade
 * packs; the INSERT OR IGNORE in writePack collapses it to one entry here, so
 * the total comes in a little under decades x perDecade.
 */
function buildAllTime(conn) {
  const decades = conn.prepare(
    "SELECT id, name FROM packs WHERE kind = 'decade' ORDER BY sort"
  ).all();
  if (!decades.length) {
    say('\nNo decade packs yet, skipping the All Time pack.');
    return 0;
  }

  // Same ORDER BY as packs.js uses to hand tracks to the game -- and therefore
  // the same order `npm run warm` walked when it resolved previews.
  const pick = conn.prepare(`
    SELECT pt.track_id, pt.year, t.popularity
      FROM pack_tracks pt
      JOIN tracks t ON t.id = pt.track_id
     WHERE pt.pack_id = ?
     ORDER BY t.popularity DESC NULLS LAST, pt.rank ASC
     LIMIT ?
  `);

  const picked = [];
  for (const decade of decades) {
    const rows = pick.all(decade.id, ALL_TIME.perDecade);
    picked.push(...rows);
    say(`  ${decade.name}: top ${rows.length}`);
  }

  // Rank across the whole pack by popularity, so position 1 is the single most
  // recognisable song in it rather than the best song of whichever decade
  // happened to be read first.
  picked.sort((a, b) => (b.popularity ?? -1) - (a.popularity ?? -1));

  const rows = db.transaction(conn, () => {
    const out = picked.map((r, i) => ({ trackId: r.track_id, rank: i + 1, year: r.year }));
    writePack(conn, {
      id: ALL_TIME.id,
      name: ALL_TIME.name,
      blurb: ALL_TIME.blurb,
      icon: ALL_TIME.icon,
      kind: 'mixed',
      sort: -1,   // ahead of the decades
      source: `Top ${ALL_TIME.perDecade} of each decade pack, by popularity`
    }, out);
    return out;
  });

  const actual = conn.prepare(
    'SELECT COUNT(*) n FROM pack_tracks WHERE pack_id = ?'
  ).get(ALL_TIME.id).n;
  say(`  => ${actual} tracks (${rows.length - actual} shared across two decades)`);
  return actual;
}

/* --------------------------------------------------------------- popularity */

/**
 * Every spelling of a track worth asking Last.fm about.
 *
 * Wikipedia and Last.fm disagree about where a featured artist goes. Wikipedia
 * puts it in the credit ("Doja Cat featuring SZA" / "Kiss Me More"); Last.fm
 * usually bakes it into the title ("Doja Cat" / "Kiss Me More (feat. SZA)").
 * Ask for the wrong one and you get a sparsely-populated duplicate entry rather
 * than the real one -- 19k listeners instead of 1.97M. The same happens in
 * reverse for chart suffixes: "Despacito (Remix)" has 11k, "Despacito" 650k.
 *
 * So we try each plausible spelling and keep the largest count. Taking the max
 * is the right call rather than a hack: all of these name the same song, Last.fm
 * has split its listeners across the variants, and the fullest entry is the best
 * estimate of how widely the song is actually known.
 */
function titleCandidates(title, artist) {
  const out = [title];

  // "Title (Remix)" -> "Title"
  const stripped = title.replace(/\s*[([].*?[)\]]\s*$/, '').trim();
  if (stripped && stripped !== title) out.push(stripped);

  // "Doja Cat featuring SZA" -> "Title (feat. SZA)"
  const featured = String(artist || '').split(/\bfeaturing\b|\bfeat\.?\b|\bft\.?\b/i)[1];
  if (featured && featured.trim()) {
    out.push(`${stripped || title} (feat. ${featured.trim()})`);
  }

  return [...new Set(out)];
}

/**
 * Fill in Last.fm listener counts for tracks that have none yet.
 *
 * This is the expensive phase -- one request per track -- so it is resumable:
 * only rows with a NULL lastfm_listeners are fetched, and a track that Last.fm
 * does not know is marked with 0 so it is not retried on every run.
 */
async function enrich(conn, limit) {
  const todo = conn.prepare(`
    SELECT id, title, artist FROM tracks
     WHERE lastfm_listeners IS NULL
     ORDER BY COALESCE(billboard_best, 9999), id
     LIMIT ?
  `).all(limit);

  if (!todo.length) {
    say('\nEvery track already has listener counts.');
    return 0;
  }

  say(`\nFetching Last.fm listener counts for ${todo.length} track(s)`);
  const update = conn.prepare(
    'UPDATE tracks SET lastfm_listeners = ?, lastfm_playcount = ?, updated_at = ? WHERE id = ?'
  );

  /*
   * One bad response must not end the pass. This used to `break` on any error,
   * so a single transient blip 45% of the way through abandoned the remaining
   * 4,000 tracks -- and still exited 0, reporting success. Now a failure skips
   * that track (leaving it NULL so a later run retries it) and only a long run
   * of consecutive failures is treated as "the API is actually down".
   */
  const GIVE_UP_AFTER = 25;

  let done = 0;
  let found = 0;
  let failed = 0;
  let streak = 0;
  let aborted = false;

  for (const track of todo) {
    let info = null;
    try {
      // Lead artist only: Last.fm cannot place a full "X featuring Y and Z"
      // credit and will invent a believable answer rather than admit it.
      const artist = leadArtist(track.artist);
      for (const candidate of titleCandidates(track.title, track.artist)) {
        const hit = await lastfm.trackInfo(candidate, artist);
        if (hit && (!info || hit.listeners > info.listeners)) info = hit;
      }
      streak = 0;
    } catch (err) {
      failed++;
      if (++streak >= GIVE_UP_AFTER) {
        say(`  stopping: ${streak} consecutive failures (${err.message})`);
        aborted = true;
        break;
      }
      continue;   // leave it NULL; the next run picks it up
    }
    // 0 records "asked, nothing there" so the next run skips it.
    update.run(info ? info.listeners : 0, info ? info.playcount : 0, Date.now(), track.id);
    if (info) found++;
    if (++done % 250 === 0) say(`  ${done}/${todo.length}`);
  }

  say(`  ${done} looked up, ${found} with data`
    + (failed ? `, ${failed} failed and left for a later run` : ''));
  return { done, failed, aborted, remaining: todo.length - done - failed };
}

/**
 * Recompute the 0..100 popularity score for every track.
 *
 * Why a percentile rather than a scaled count: listener counts are power-law
 * distributed (a megahit has ~2M, a deep cut ~5k), so any linear scaling pins
 * almost everything near zero and the number stops being useful for choosing
 * difficulty bands. A percentile spreads tracks evenly by construction, which is
 * exactly what "give me the top 20% most recognisable" wants.
 *
 * Signal preference:
 *   1. Last.fm listeners -- how widely known a song is *today*, which is what
 *      makes it easy or hard to guess now.
 *   2. Billboard year-end rank -- how big it was *then*. Always available for
 *      decade tracks and needs no API key, so it keeps the column meaningful
 *      before anyone has run the enrichment pass.
 *
 * The two are ranked in separate pools and Billboard-only tracks are mapped into
 * the lower half, because "was a hit in 1974" is weaker evidence of present-day
 * recognisability than a live listener count.
 */
function score(conn) {
  const rows = conn.prepare(`
    SELECT id, lastfm_listeners AS listeners, billboard_best AS best, billboard_years AS years
      FROM tracks
  `).all();
  if (!rows.length) return { total: 0, byListeners: 0, byChart: 0 };

  const withListeners = rows.filter((r) => r.listeners != null && r.listeners > 0);
  const chartOnly = rows.filter(
    (r) => !(r.listeners != null && r.listeners > 0) && r.best != null
  );
  const neither = rows.filter(
    (r) => !(r.listeners != null && r.listeners > 0) && r.best == null
  );

  const update = conn.prepare(
    'UPDATE tracks SET popularity = ?, popularity_source = ? WHERE id = ?'
  );

  db.transaction(conn, () => {
    // Listener pool: percentile across 0..100.
    withListeners.sort((a, b) => a.listeners - b.listeners);
    withListeners.forEach((row, i) => {
      const pct = withListeners.length === 1 ? 100 : (i / (withListeners.length - 1)) * 100;
      update.run(round2(pct), 'lastfm_listeners', row.id);
    });

    /*
     * Chart-only pool: map rank 1..100 straight onto 0..CHART_CEILING.
     *
     * Not a percentile, unlike the pool above. Year-end position is already an
     * ordinal with only 100 distinct values shared between ~5,000 tracks, so a
     * percentile would hand the ~56 different #1 singles 56 visibly different
     * scores decided by nothing but sort order. A direct map gives every #1 the
     * same score, which is the truth: on this signal they are tied.
     *
     * Charting across more than one year is the one genuine tiebreak available
     * -- it means the song had staying power -- so it earns a small bonus.
     */
    for (const row of chartOnly) {
      const rank = Math.min(100, Math.max(1, row.best));
      const base = CHART_CEILING * (1 - (rank - 1) / 100);
      const staying = Math.min(3, ((row.years || 1) - 1) * 1.5);
      update.run(round2(Math.min(CHART_CEILING, base + staying)), 'billboard_rank', row.id);
    }

    for (const row of neither) update.run(null, null, row.id);
  });

  return {
    total: rows.length,
    byListeners: withListeners.length,
    byChart: chartOnly.length,
    unscored: neither.length
  };
}

/*
 * Chart-derived scores are capped below 100 on purpose. "Was a big hit decades
 * ago" is weaker evidence of present-day recognisability than a live listener
 * count, so a track priced only on its chart run should never outrank one we
 * have real listener data for.
 */
const CHART_CEILING = 60;

const round2 = (n) => Math.round(n * 100) / 100;

/* --------------------------------------------------------------------- cli */

function parseArgs(argv) {
  const opts = { decades: false, genres: false, enrich: false, scoreOnly: false, from: null, limit: 8000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--decades') opts.decades = true;
    else if (arg === '--genres') opts.genres = true;
    else if (arg === '--enrich') opts.enrich = true;
    else if (arg === '--score') opts.scoreOnly = true;
    else if (arg === '--from') opts.from = parseInt(argv[++i], 10) || null;
    else if (arg === '--limit') opts.limit = parseInt(argv[++i], 10) || opts.limit;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else say(`(ignoring unknown flag ${arg})`);
  }
  // No phase flags at all means "do the lot".
  if (!opts.decades && !opts.genres && !opts.enrich && !opts.scoreOnly) {
    opts.decades = opts.genres = opts.enrich = true;
  }
  return opts;
}

const USAGE = `
Populate the MemoryBeat song database.

  npm run build-packs                    everything (decades, genres, listener counts)
  npm run build-packs -- --decades       Billboard year-end decade packs only
  npm run build-packs -- --genres        Last.fm genre packs only
  npm run build-packs -- --enrich        fetch missing listener counts only
  npm run build-packs -- --score         recompute popularity from stored signals

  --from YEAR      skip chart years before YEAR
  --limit N        cap how many tracks --enrich looks up in one run (default 8000)

Genre packs and listener counts need a free Last.fm API key:
  https://www.last.fm/api/account/create
  then set LASTFM_API_KEY in the environment.
`;

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    say(USAGE);
    process.exit(0);
  }

  const conn = db.open();
  const skipped = [];
  let incomplete = false;

  if (opts.decades) {
    const n = await buildDecades(conn, opts);
    say(`\n${n} decade pack(s) written.`);
  }

  if (opts.genres) {
    if (!lastfm.available()) {
      skipped.push('genre packs (no LASTFM_API_KEY)');
    } else {
      const n = await buildGenres(conn);
      say(`\n${n} genre pack(s) written.`);
    }
  }

  if (opts.enrich) {
    if (!lastfm.available()) {
      skipped.push('Last.fm listener counts (no LASTFM_API_KEY)');
    } else {
      const result = await enrich(conn, opts.limit);
      if (result.aborted || result.failed || result.remaining) incomplete = true;
    }
  }

  /*
   * Drop tracks no pack references any more. Membership is rewritten wholesale
   * on every build, so a track whose title changed upstream (or whose parsing
   * was corrected here) leaves its old row behind unreferenced. Safe by
   * construction: anything still in a pack is joined to by pack_tracks.
   */
  const orphans = conn.prepare(`
    DELETE FROM tracks
     WHERE id NOT IN (SELECT track_id FROM pack_tracks)
  `).run();
  if (orphans.changes) say(`\nRemoved ${orphans.changes} track(s) no longer in any pack.`);

  // Always rescore: whatever signals exist now, the ranking should reflect them.
  const stats = score(conn);
  say('\nPopularity');
  say(`  ${stats.byListeners} track(s) ranked on Last.fm listeners`);
  say(`  ${stats.byChart} track(s) ranked on Billboard year-end position`);
  if (stats.unscored) say(`  ${stats.unscored} track(s) with no signal yet`);

  // After scoring: this pack is defined as "the top N of each decade", and top
  // means top by the popularity we just computed.
  say('\nAll Time');
  buildAllTime(conn);

  const packs = conn.prepare(`
    SELECT p.name, p.kind, COUNT(pt.track_id) AS n
      FROM packs p LEFT JOIN pack_tracks pt ON pt.pack_id = p.id
     GROUP BY p.id ORDER BY p.sort
  `).all();

  say('\nPacks in the database:');
  for (const p of packs) say(`  ${String(p.n).padStart(5)}  ${p.name} (${p.kind})`);
  say(`\n${stats.total} track(s) total in ${db.DB_FILE}`);

  if (skipped.length) {
    say('\nSkipped:');
    for (const s of skipped) say(`  ${s}`);
    say('\nGet a free key at https://www.last.fm/api/account/create, then:');
    say('  LASTFM_API_KEY=... npm run build-packs');
  }

  // Say so, and exit non-zero: an enrichment pass that stopped short used to
  // look identical to one that finished.
  if (stats.unscored || incomplete) {
    say(`\n${stats.unscored} track(s) still have no popularity signal.`);
    say('Re-run to pick up where this left off:');
    say('  LASTFM_API_KEY=... npm run build-packs -- --enrich');
  }

  db.close();
  process.exit(incomplete ? 1 : 0);
})().catch((err) => {
  say(`\nbuild-packs failed: ${err.stack || err.message}`);
  process.exit(1);
});
