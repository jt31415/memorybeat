'use strict';

/**
 * Loads .env into process.env, if there is one.
 *
 * node:sqlite already puts the floor at Node 22 (see db.js), and that ships
 * process.loadEnvFile() -- so this needs no dependency and no `--env-file` flag
 * on every entry point. Requiring this module is the whole API; it must happen
 * before anything reads process.env.
 *
 * Missing file is the normal case in production, where the platform injects real
 * environment variables and there is nothing to load. Anything else is worth a
 * warning, but never fatal: every credential this project takes is optional, and
 * a malformed .env should not stop a game that was going to work without it.
 */

const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');

let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn(`[env] could not read ${ENV_FILE}: ${err.message}`);
    }
  }
}

load();

/** Trimmed value, or '' -- so a key left as `FOO=` reads the same as unset. */
function get(name) {
  return String(process.env[name] || '').trim();
}

module.exports = { get, ENV_FILE };
