import { useEffect, useState } from 'react';
import { Wordmark, DiscordAvatar } from '../components/common.jsx';
import { ShareIcon } from '../components/glyphs.jsx';
import { countdown, localDate, num, plural } from '../lib/format.js';
import { copyText, shareText, speed } from '../lib/share.js';
import { useDaily, useNow, signOut } from '../lib/useDaily.js';

/*
 * The daily challenge page: sign in, play once, see where you landed.
 *
 * No socket here. The game itself is an ordinary solo room and happens on
 * /r/CODE like every other game -- this page's whole job is the bit either
 * side of it.
 */

const EMPTY_BOARD = {
  today: "Nobody has finished today's challenge yet. Be first.",
  yesterday: "Nobody finished yesterday's challenge.",
  week: 'No runs yet this week. Be first.',
  allTime: 'No runs recorded yet.'
};

const BOARDS = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['week', 'This week'],
  ['allTime', 'All time']
];

/** Boards over one day show a run; boards over many show a total. */
const isDayBoard = (key) => key === 'today' || key === 'yesterday';

const shortDate = (day) => localDate(day, { weekday: 'short', day: 'numeric', month: 'short' });

/* What span a board covers, where that is not obvious from its name. "This
   week" is Monday to Sunday UTC -- which, named in local time like every other
   date here, is Sunday to Saturday for anyone in the Americas -- and saying
   when it resets is what makes it read as a race. */
function boardCaption(board, data, now) {
  if (board === 'yesterday') return shortDate(data.yesterday.day);
  if (board === 'week') {
    const left = Math.max(0, data.weekResetsAt - now);
    const days = Math.floor(left / 86400000);
    const hours = Math.floor(left / 3600000) % 24;
    const lastDay = new Date(data.weekResetsAt - 86400000).toISOString().slice(0, 10);
    return `${shortDate(data.weekStart)} – ${shortDate(lastDay)} · resets in `
      + (days ? `${days}d ${hours}h` : `${hours}h`);
  }
  return '';
}

export default function Daily() {
  const { data, error: loadError, reload } = useDaily();
  const now = useNow(!!data);
  const [board, setBoard] = useState('today');
  const [view, setView] = useState('today'); // whose result the card shows
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  /* An error carried back from the OAuth callback -- it redirects here rather
     than rendering a dead-end page of its own. */
  useEffect(() => {
    const failure = new URLSearchParams(location.search).get('error');
    if (failure) {
      setError(failure.slice(0, 200));
      history.replaceState(null, '', '/daily');
    }
  }, []);

  /* Rolled over while the page sat open: reload rather than quietly offering
     yesterday's challenge and a leaderboard nobody is on any more. */
  useEffect(() => {
    if (data && now >= data.resetsAt) location.reload();
  }, [data, now]);

  async function start() {
    setStarting(true);
    setError('');
    try {
      const res = await fetch('/api/daily/start', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.code) {
        setStarting(false);
        setError(body.error || 'Could not start the daily challenge. Try again.');
        // A 409 means somebody finished a run in another tab while this one sat
        // here; reloading shows the score rather than a button that won't work.
        if (res.status === 409) reload();
        return;
      }
      location.href = `/r/${body.code}`;
    } catch {
      setStarting(false);
      setError('Could not reach the server. Check your connection and try again.');
    }
  }

  return (
    <div className="page daily">
      <header className="page-top">
        <Wordmark />
        <span className="spacer" />
        {data && data.user && (
          <div className="whoami">
            <span className="whoami-name">{data.user.name}</span>
            <DiscordAvatar src={data.user.avatar} size={30} />
            <button type="button" className="btn-quiet small" onClick={signOut}>Sign out</button>
          </div>
        )}
      </header>

      <div className="daily-body">
        <section className="daily-main">
          <div>
            <h1 className="daily-title">Daily challenge</h1>
            <p className="daily-sub">
              {data ? localDate(data.day, { weekday: 'long', day: 'numeric', month: 'long' }) : ' '}
              {' · '}same five songs for everyone
            </p>
          </div>

          {!data && !loadError && <p className="hint">Loading today's challenge…</p>}
          {data && (
            <DailyAction
              data={data}
              view={view}
              setView={setView}
              starting={starting}
              onStart={start}
            />
          )}
          {(error || loadError) && <p className="error" role="alert">{error || loadError}</p>}

          {data && (
            <div className="daily-reset">
              <span>Next daily in</span>
              <span className="mono daily-clock">{countdown(data.resetsAt, now)}</span>
            </div>
          )}
        </section>

        <section className="daily-boards" aria-labelledby="board-title">
          <div className="boards-head">
            <h2 id="board-title">Leaderboard</h2>
            <span className="spacer" />
            <div className="tabs" role="tablist" aria-label="Leaderboard">
              {BOARDS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={board === key}
                  className="tab"
                  onClick={() => setBoard(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {data && <Board board={board} data={data} now={now} />}
        </section>
      </div>
    </div>
  );
}

/**
 * The one thing this page wants you to do right now.
 *
 * The possibilities are mutually exclusive by construction -- the server
 * decides which by what it puts in the payload, so this cannot end up showing
 * a Play button to somebody who has already played. Signed in, there is also a
 * look back at yesterday, which is its own view rather than another state:
 * whatever today looks like, yesterday is final.
 */
function DailyAction({ data, view, setView, starting, onStart }) {
  if (!data.available) {
    return (
      <div className="card">
        <p className="hint">The daily challenge is switched off on this server — it needs Discord sign-in configured.</p>
      </div>
    );
  }

  if (!data.user) {
    return (
      <div className="card">
        <p className="card-lead">
          The daily has one run per person and a global leaderboard, so it needs to know who you are.
          Signing in shares your Discord name and avatar — nothing else.
        </p>
        <a className="btn btn-lg btn-discord btn-block" href={`/auth/discord?returnTo=${encodeURIComponent('/daily')}`}>
          Sign in with Discord
        </a>
      </div>
    );
  }

  const tabs = (
    <div className="tabs small" role="tablist" aria-label="Your results">
      {[['today', 'Today'], ['yesterday', 'Yesterday']].map(([key, label]) => (
        <button key={key} type="button" role="tab" className="tab" aria-selected={view === key} onClick={() => setView(key)}>
          {label}
        </button>
      ))}
    </div>
  );

  if (view === 'yesterday') {
    const y = data.yesterday;
    const mine = y.played;
    return (
      <div className="card">
        {tabs}
        {mine ? <ResultStats mine={mine} /> : (
          <p className="hint">
            {y.songs.length ? "You didn't play yesterday's challenge. Here's what you missed:" : 'There was no challenge yesterday.'}
          </p>
        )}
        <RoundList roundMs={mine ? mine.roundMs : null} songs={y.songs.length ? y.songs : null} />
        {mine && <ShareButton day={y.day} result={mine} />}
      </div>
    );
  }

  if (data.played) {
    const mine = data.played;
    return (
      <div className="card">
        {tabs}
        <ResultStats mine={mine} />
        {/* Times only: today's titles are still somebody else's puzzle. */}
        <SpeedCells roundMs={mine.roundMs} />
        <ShareButton day={data.day} result={mine} />
      </div>
    );
  }

  if (data.resume) {
    return (
      <div className="card">
        {tabs}
        <p className="card-lead">
          You've got a run in progress and the clock is still going. Jump back in now — leave it
          and it's filed with the rounds you've played.
        </p>
        <a className="btn btn-lg tone-tangerine btn-block" href={`/r/${data.resume}`}>Resume run</a>
      </div>
    );
  }

  return (
    <div className="card">
      {tabs}
      <p className="card-lead">
        Type the title before the clip runs out. One run a day, no restarts — once you press play,
        finishing or leaving locks your score in.
      </p>
      <button type="button" className="btn btn-xl tone-tangerine btn-block" onClick={onStart} disabled={starting}>
        {starting ? 'Starting…' : `Play today's ${data.rounds} songs`}
      </button>
    </div>
  );
}

function ResultStats({ mine }) {
  return (
    <div className="result-stats">
      <div className="stat">
        <span className="stat-label">Score</span>
        <span className="stat-value big">{num(mine.score)}</span>
      </div>
      <div className="stat">
        <span className="stat-label">Correct</span>
        <span className="stat-value">{mine.correct}/{mine.rounds}</span>
      </div>
      <div className="stat right">
        <span className="stat-label">Rank of {num(mine.of)}</span>
        <span className="stat-value butter">#{mine.rank}</span>
      </div>
    </div>
  );
}

/** One cell per round, coloured by how quickly it was solved. */
function SpeedCells({ roundMs }) {
  if (!Array.isArray(roundMs) || !roundMs.length) return null;
  return (
    <ol className="speed-cells" aria-label="Your rounds">
      {roundMs.map((ms, i) => (
        <li key={i} className={`speed-cell ${speed(ms)}`}>
          <span className="mono">{ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`}</span>
          <span className="speed-word">{ms == null ? 'missed' : speed(ms) === 'fast' ? 'fast' : 'slow'}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * One row per round: the song when it can be shown, the time when there is one.
 * Either input can be missing -- a run from before round times were kept has
 * no times, and a day nobody played has no result -- and the list is built from
 * whichever is there.
 */
function RoundList({ roundMs, songs }) {
  const count = songs ? songs.length : (roundMs ? roundMs.length : 0);
  if (!count) return null;
  return (
    <ol className="round-list">
      {Array.from({ length: count }, (_, i) => {
        const song = songs && songs[i];
        const ms = roundMs ? roundMs[i] : undefined;
        return (
          <li key={i}>
            <span className="n">{i + 1}</span>
            <span className="song">
              <b>{song ? song.title : `Round ${i + 1}`}</b>
              {song && <span>{song.artist}</span>}
            </span>
            {roundMs && (
              <span className={`time ${speed(ms)}`}>{ms == null ? 'miss' : `${(ms / 1000).toFixed(1)}s`}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ShareButton({ day, result }) {
  const [label, setLabel] = useState('Share your result');
  useEffect(() => {
    if (label === 'Share your result') return undefined;
    const t = setTimeout(() => setLabel('Share your result'), 2000);
    return () => clearTimeout(t);
  }, [label]);
  return (
    <button
      type="button"
      className="btn btn-lg tone-cream btn-block"
      onClick={async () => setLabel((await copyText(shareText(day, result))) ? 'Copied!' : "Couldn't copy — try again")}
    >
      <ShareIcon width="20" height="20" />
      {label}
    </button>
  );
}

function Board({ board, data, now }) {
  const rows = data.boards[board] || [];
  const caption = boardCaption(board, data, now);
  const meId = data.user ? data.user.id : null;

  return (
    <div className="board">
      {caption && <p className="board-caption">{caption}</p>}
      {!rows.length && <p className="hint">{EMPTY_BOARD[board]}</p>}
      <ol className="board-list">
        {rows.map((entry, i) => (
          <li key={entry.id} className={entry.id === meId ? 'me' : ''}>
            <span className={`rank rank-${i + 1}`}>{i + 1}</span>
            <DiscordAvatar src={entry.avatar} size={34} />
            <span className="who">{entry.id === meId ? `${entry.name} (you)` : entry.name}</span>
            {/* The multi-day boards carry a days count the daily ones have no
                room for and no meaning for. */}
            <span className="meta">
              {isDayBoard(board) ? `${entry.correct}/${entry.rounds}` : plural(entry.days, 'day')}
            </span>
            <span className="score">{num(entry.score)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
