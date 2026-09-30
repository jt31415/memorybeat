import { useCallback, useEffect, useState } from 'react';

/**
 * /api/daily, for the pages that paint themselves with it: who you are,
 * whether you have played, and every board.
 *
 * Which state a page shows is the server's call. Whether you have played today
 * is a row in a table on the other end of the wire; asking and believing the
 * answer is the only version of that check that means anything.
 */
export function useDaily() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/daily');
      if (!res.ok) throw new Error(`daily returned ${res.status}`);
      setData(await res.json());
      setError('');
    } catch {
      setError('Could not load the daily challenge. Refresh to try again.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { data, error, reload: load };
}

/** Re-render every second, for anything showing a live countdown. */
export function useNow(active = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export async function signOut() {
  try {
    await fetch('/auth/logout', { method: 'POST' });
  } catch { /* signing out locally is the part that matters */ }
  location.reload();
}
