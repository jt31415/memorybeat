/* Everything this app keeps in the browser, under the `mb:` prefix. */

/* Storage moved from the old `gts:` prefix to `mb:` with the rename. Carry the
   handful of keys across once so nobody loses their name or volume. */
export function migrateStorage() {
  try {
    if (localStorage.getItem('mb:migrated')) return;
    for (const key of ['pid', 'name', 'vol']) {
      const old = localStorage.getItem(`gts:${key}`);
      if (old !== null && localStorage.getItem(`mb:${key}`) === null) {
        localStorage.setItem(`mb:${key}`, old);
      }
    }
    localStorage.setItem('mb:migrated', '1');
  } catch { /* private mode: defaults are fine */ }
}

function read(store, key) {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function write(store, key, value) {
  try {
    store.setItem(key, value);
  } catch { /* private mode: it just won't be remembered */ }
}

/** This browser's player id: stable across visits, never shown to anyone. */
export function playerId() {
  let pid = read(localStorage, 'mb:pid');
  if (!pid) {
    pid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    write(localStorage, 'mb:pid', pid);
  }
  return pid;
}

export const savedName = () => read(localStorage, 'mb:name') || '';
export const saveName = (name) => write(localStorage, 'mb:name', name);

export function savedVolume() {
  const raw = read(localStorage, 'mb:vol');
  const n = raw === null ? 80 : Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 80;
}
export const saveVolume = (v) => write(localStorage, 'mb:vol', String(v));

/* A room password lives for the tab, so a reload or reconnect gets back in
   without asking again, and nothing about it outlives the session. */
export const savedPassword = (code) => read(sessionStorage, `mb:pw:${code}`) || '';
export const savePassword = (code, pw) => write(sessionStorage, `mb:pw:${code}`, pw);
