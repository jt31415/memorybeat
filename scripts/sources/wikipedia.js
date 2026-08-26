'use strict';

/**
 * Billboard Year-End Hot 100 singles, scraped from Wikipedia.
 *
 * One page per year ("Billboard Year-End Hot 100 singles of 1984"), each with a
 * single wikitable of No. / Title / Artist(s). We go through the MediaWiki parse
 * API and read the rendered HTML rather than the wikitext: the wikitext varies a
 * lot across fifty years of editing (templates, inline refs, differing quote
 * styles) while the parser's HTML output is uniform.
 *
 * The year-end rank is also the popularity signal for these tracks -- a #3
 * year-end single was, definitionally, one of the biggest songs of its year.
 */

const API = 'https://en.wikipedia.org/w/api.php';

// Wikipedia's API etiquette asks for a descriptive agent that identifies the
// tool, so a rate-limit problem can be traced back to a human.
const UA = 'memorybeat/1.0 (song pack builder; +https://github.com/memorybeat)';

// One page per year means ~56 requests in a burst, which is enough to earn a
// 429. A second between fetches costs about a minute over a full build and
// keeps us comfortably inside what the API expects from an anonymous client.
const GAP_MS = 1000;
const MAX_ATTEMPTS = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chain = Promise.resolve();
let last = 0;

/** Serialise every request through one queue with a minimum gap. */
function schedule(fn) {
  const run = chain.then(async () => {
    const wait = GAP_MS - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    last = Date.now();
    return fn();
  });
  chain = run.then(() => {}, () => {});
  return run;
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…'
};

function decodeEntities(str) {
  return String(str)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
    });
}

/** Rendered cell HTML -> plain text. */
function cellText(html) {
  return decodeEntities(
    String(html)
      // Footnote markers and edit links render as real content otherwise.
      .replace(/<sup[\s\S]*?<\/sup>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\[\s*[a-z0-9]+\s*\]/gi, ' ')   // leftover [a] / [12] refs
    .replace(/\s+/g, ' ')
    // Each name in a credit list is its own link, so stripping tags leaves
    // gaps around the punctuation between them: "Dionne and Friends ( Dionne
    // Warwick , Gladys Knight )". Close those up.
    .replace(/\s+([,;:.!?)\]])/g, '$1')
    .replace(/([(\[])\s+/g, '$1')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rowCells(rowHtml) {
  const cells = rowHtml.match(/<t[hd]\b[\s\S]*?<\/t[hd]>/gi) || [];
  return cells.map(cellText);
}

/**
 * Titles are rendered inside typographic or plain quotes; strip them.
 *
 * Double A-sides are listed as two separately quoted songs in one cell --
 * `"Maggie May" / "Reason to Believe"`. Stripping only the outer quotes left
 * `Maggie May" / "Reason to Believe`, which is two songs, unguessable, and
 * matches nothing in any music API. So when the cell opens with a quote, take
 * just the first quoted segment: the A-side is the song people know.
 *
 * An unquoted slash is left alone, because there it belongs to the title --
 * "Uncle Albert/Admiral Halsey" really is one song.
 */
function cleanTitle(raw) {
  // Double quotes only. An apostrophe is a title character, not a delimiter --
  // treating it as one truncated "It's Too Late" to "It".
  const quoted = /^\s*["“]\s*([^"”]+?)\s*["”]/.exec(raw);
  if (quoted) return quoted[1].trim();
  return raw
    .replace(/^["'“”‘’]+/, '')
    .replace(/["'“”‘’]+$/, '')
    .trim();
}

async function fetchOnce(year) {
  const params = new URLSearchParams({
    action: 'parse',
    page: `Billboard Year-End Hot 100 singles of ${year}`,
    prop: 'text',
    formatversion: '2',
    format: 'json',
    redirects: '1'
  });
  const res = await fetch(`${API}?${params}`, { headers: { 'User-Agent': UA } });

  if (res.status === 429 || res.status >= 500) {
    const err = new Error(`Wikipedia HTTP ${res.status} for ${year}`);
    err.retryable = true;
    // Honour the server's own pacing advice when it gives any.
    const retryAfter = Number(res.headers.get('retry-after'));
    err.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
    throw err;
  }
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status} for ${year}`);

  const body = await res.json();
  if (body.error) {
    // A year that has not happened yet, or has no page, is not a failure.
    if (body.error.code === 'missingtitle') return null;
    throw new Error(`Wikipedia API ${body.error.code} for ${year}`);
  }
  return body.parse && body.parse.text ? body.parse.text : null;
}

async function fetchYearHtml(year) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await schedule(() => fetchOnce(year));
    } catch (err) {
      lastErr = err;
      if (!err.retryable) throw err;
      // 2s, 4s, 8s, 16s -- or whatever Retry-After asked for, if longer.
      const backoff = Math.max(err.retryAfterMs || 0, 2000 * Math.pow(2, attempt));
      await sleep(backoff);
    }
  }
  throw lastErr;
}

/**
 * @returns {Promise<Array<{rank:number,title:string,artist:string,year:number}>>}
 *          Empty when the page does not exist.
 */
async function yearEndHot100(year) {
  const html = await fetchYearHtml(year);
  if (!html) return [];

  const table = html.match(/<table[^>]*\bwikitable\b[\s\S]*?<\/table>/i);
  if (!table) throw new Error(`no wikitable on the ${year} page`);

  const rows = table[0].match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  if (!rows.length) throw new Error(`no rows in the ${year} table`);

  // Read the header rather than assuming column order. It has been
  // No./Title/Artist(s) for every year checked, but a single re-ordered page
  // would otherwise silently load artists as titles.
  const header = rowCells(rows[0]).map((h) => h.toLowerCase());
  const titleCol = header.findIndex((h) => h.startsWith('title'));
  const artistCol = header.findIndex((h) => h.startsWith('artist'));
  const rankCol = header.findIndex((h) => h.startsWith('no') || h === '#');
  if (titleCol < 0 || artistCol < 0) {
    throw new Error(`unexpected columns on the ${year} page: ${header.join(' | ')}`);
  }

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rowCells(rows[i]);
    if (cells.length <= Math.max(titleCol, artistCol)) continue;

    const title = cleanTitle(cells[titleCol]);
    const artist = cells[artistCol];
    if (!title || !artist) continue;

    const rank = rankCol >= 0 ? parseInt(cells[rankCol], 10) : NaN;
    out.push({
      rank: Number.isFinite(rank) ? rank : out.length + 1,
      title,
      artist,
      year
    });
  }
  return out;
}

module.exports = { yearEndHot100 };
