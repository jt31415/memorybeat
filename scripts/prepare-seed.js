'use strict';

/**
 * Strip runtime state out of the image's seed copy of memorybeat.db.
 *
 * Run by the Dockerfile against data-seed/, never against data/. The build
 * machine's database can still carry the tables that used to live there --
 * settings (with its session secret) and the daily challenge's runs and frozen
 * songs -- and a seed that carried them would hand the build machine's test
 * runs to any server that reseeds. They belong in state.db, which the image
 * never contains; see server/db.js.
 *
 * Also folds any WAL back into the main file and deletes the -wal/-shm pair, so
 * the seed is one self-contained file that a reseed can copy on its own.
 *
 *   node scripts/prepare-seed.js data-seed/memorybeat.db
 */

const fs = require('fs');
const path = require('path');

// Same muting as server/db.js: node:sqlite warns on load, and the warning is
// noise in a build log.
const originalEmit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = String(typeof warning === 'object' && warning ? warning.message : warning);
  if (/SQLite/i.test(text)) return;
  return originalEmit.call(process, warning, ...rest);
};

const { DatabaseSync } = require('node:sqlite');

const STATE_TABLES = ['settings', 'daily_challenges', 'daily_runs'];

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/prepare-seed.js <path/to/memorybeat.db>');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.log(`[seed] ${file} not found, nothing to prepare`);
  process.exit(0);
}

const conn = new DatabaseSync(file);
for (const table of STATE_TABLES) {
  conn.exec(`DROP TABLE IF EXISTS ${table}`);
}
conn.exec('PRAGMA wal_checkpoint(TRUNCATE)');
conn.exec('PRAGMA journal_mode = DELETE');
conn.exec('VACUUM');
conn.close();

for (const suffix of ['-wal', '-shm']) {
  fs.rmSync(file + suffix, { force: true });
}

console.log(`[seed] stripped ${STATE_TABLES.join(', ')} from ${path.basename(file)}`);
