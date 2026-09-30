import { useEffect, useRef, useState } from 'react';
import { Avatar } from '../components/common.jsx';
import { CheckIcon, CopyIcon, CrownIcon, GridIcon, KeyboardIcon, PlayIcon } from '../components/glyphs.jsx';
import { copyText } from '../lib/share.js';
import { num, plural } from '../lib/format.js';

/*
 * The lobby: who is here, and -- for whoever gets to choose -- what the next
 * game is. Mode first, because it decides what the game *is*; then songs,
 * difficulty and length, each of which is chosen for a mode.
 *
 * The server decides everything. No control here highlights optimistically:
 * a click sends a request, and the state sync that comes back paints the
 * result, so a click crossing with a sync cannot leave the two disagreeing.
 */

const IMPORT_PREFIX = 'pl:';
const isImportId = (id) => String(id || '').startsWith(IMPORT_PREFIX);
const SOURCE_ICON = { deezer: 'DZ', spotify: 'SP' };
const MODE_ICON = { classic: KeyboardIcon, choice: GridIcon };

/* Stops rather than a slider or a number box: the difference between 12 and 13
   rounds is not a decision anybody wants to make. Filtered against the
   server's own bounds, so raising the ceiling there widens this on its own. */
const ROUND_STOPS = [3, 5, 10, 15, 20, 30, 40, 50];

const inLobby = (state) => state.state === 'lobby' || state.state === 'ended';

/** The host, in an ordinary room -- never in a daily, where every setting is
 *  fixed for the day and a control that cannot change anything is worse than
 *  no control at all. The server refuses the changes regardless. */
export const canConfigure = (state, me) => !!state && state.hostPid === me && !state.daily;

/** Whether this browser gets to pick songs: the host always, everybody else
 *  only while the room is mixing. */
const canPickSongs = (state, me) =>
  !!state && !state.daily && inLobby(state) && (state.hostPid === me || !!state.mix);

/**
 * This browser's own selection. Off-mix that is the room's, since only the
 * host can have set it. In a mix every player has their own, and the one being
 * toggled is always ours.
 */
function mySelection(state, me) {
  if (!state) return [];
  if (!state.mix) return state.packIds || [];
  const mine = (state.picks || []).find((p) => p.pid === me);
  return (mine && mine.ids) || [];
}

/** Our selection with one pack flipped -- unless flipping it off would leave
 *  the room with nothing to play, in which case the selection stands. */
function toggledSelection(state, me, packId) {
  const current = mySelection(state, me);
  // The server refuses a playlist merged with packs, so coming off a playlist a
  // pack click means "play this instead".
  if (current.some(isImportId)) return [packId];
  if (!current.includes(packId)) return current.concat(packId);
  // A mix contributor may put their last pack down -- the room still has
  // everybody else's. The host cannot: theirs is the fallback pool.
  if (current.length === 1) return state.mix && state.hostPid !== me ? [] : current;
  return current.filter((id) => id !== packId);
}

export function modeLabel(modes, id) {
  const info = modes.find((m) => m.id === id);
  return info ? info.label : (id || 'Type it');
}

export default function Lobby({ session }) {
  const { room, me, modes, loadingMessage, lobbyError, actions, code } = session;
  if (!room) return <div className="lobby" />;

  const isHost = room.hostPid === me;
  const isDaily = !!room.daily;
  const configure = canConfigure(room, me) && inLobby(room);
  const loading = room.state === 'loading';

  const title = loadingMessage
    ? <>{loadingMessage} <span className="loading-dots" /></>
    : isDaily ? <>Loading today's five songs <span className="loading-dots" /></>
      : room.solo ? 'Ready when you are'
        : isHost ? 'Your room is ready' : 'Waiting for the host to start';

  return (
    <div className="lobby">
      <div className="lobby-cols">
        {/* A room of one has no code to share and nobody to list, so its
            settings get the whole width. */}
        {room.solo ? null : (
          <div className="lobby-left">
            <h1 className="lobby-title">{title}</h1>
            {!isDaily && <CodeCard code={code} />}
            <Roster session={session} />
          </div>
        )}

        <div className="lobby-right">
          {room.solo && <h1 className="lobby-title">{title}</h1>}
          {configure && <ModeSwitch session={session} />}
          {canPickSongs(room, me) && <Songs session={session} />}
          <Pool session={session} />
          {configure && !room.equalWeight && <Difficulty session={session} />}
          {configure && <Rounds session={session} />}
        </div>
      </div>

      {!isDaily && (
        <div className="lobby-foot">
          <SettingsLine room={room} modes={modes} />
          {isHost && (
            <button type="button" className="btn btn-xl tone-tangerine start-btn" disabled={loading} onClick={actions.start}>
              {!loading && <PlayIcon width="22" height="22" />}
              {loading ? 'Loading songs…' : room.state === 'ended' ? 'New game' : 'Start game'}
            </button>
          )}
        </div>
      )}
      {lobbyError && <p className="error lobby-error" role="alert">{lobbyError}</p>}
    </div>
  );
}

function CodeCard({ code }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div className="code-card">
      <span className="code-card-label">Room code</span>
      <span className="code-card-code">{code}</span>
      <button
        type="button"
        className="btn code-card-copy"
        onClick={async () => setCopied(await copyText(`${location.origin}/r/${code}`))}
      >
        <CopyIcon width="18" height="18" />
        {copied ? 'Copied!' : 'Copy invite link'}
      </button>
    </div>
  );
}

function Roster({ session }) {
  const { room, me, hues } = session;
  const players = room.players;
  const open = Math.max(0, Math.min(room.maxPlayers, 12) - players.length);
  return (
    <section className="roster" aria-labelledby="roster-title">
      <div className="section-head">
        <h2 id="roster-title">In the room</h2>
        <span className="section-note mono">{players.filter((p) => p.connected).length}/{room.maxPlayers}</span>
      </div>
      <ul className="roster-grid">
        {players.map((p) => (
          <li key={p.pid} className={`roster-player${p.connected ? '' : ' away'}`}>
            {p.isHost && <CrownIcon className="roster-crown" aria-label="Host" />}
            <Avatar name={p.name} color={hues(p.pid)} size={72} ring={p.pid === me} />
            <span className="roster-name">{p.pid === me ? `${p.name} (you)` : p.name}</span>
          </li>
        ))}
        {Array.from({ length: open }, (_, i) => (
          <li key={`open-${i}`} className="roster-player open">
            <span className="avatar-open" aria-hidden="true" />
            <span className="roster-name">open</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ModeSwitch({ session }) {
  const { room, modes, actions } = session;
  const info = modes.find((m) => m.id === room.mode);
  return (
    <section className="config">
      <div className="section-head">
        <h2>Game mode</h2>
        {info && info.hint && <span className="section-note">{info.hint}</span>}
      </div>
      <div className="mode-toggle" role="group" aria-label="Game mode">
        {modes.map((mode) => {
          const Icon = MODE_ICON[mode.id] || KeyboardIcon;
          const on = room.mode === mode.id;
          return (
            <button
              key={mode.id}
              type="button"
              aria-pressed={on}
              className={`mode-opt${on ? ' on' : ''}`}
              onClick={() => actions.setMode(mode.id)}
            >
              <Icon width="28" height="28" />
              <span>
                <b>{mode.label}</b>
                <span>{mode.blurb}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** The line under the tabs: what mix is, or what it is doing. */
function sourceNoteFor(state, me, isHost) {
  if (!state.mix) {
    return isHost && !state.solo ? 'Mix lets everyone in the room bring their own songs.' : '';
  }
  const picked = (state.picks || []).filter((p) => p.ids.length).length;
  const waiting = (state.picks || []).length - picked;
  if (!mySelection(state, me).length) {
    return isHost
      ? 'Mix is on — pick your own songs, and so can everybody else.'
      : 'Mix is on — pick the songs you want in the game.';
  }
  return `Mixing ${plural(picked, 'selection')}, sampled in equal turns`
    + `${waiting ? ` · waiting on ${waiting} more` : ''}.`;
}

/*
 * Where the room's songs come from. Packs and an imported playlist are
 * alternatives, so they are tabs; Mix is a toggle across both.
 */
function Songs({ session }) {
  const { room, me, packs, actions } = session;
  const isHost = room.hostPid === me;
  const mine = mySelection(room, me);
  const kind = mine.some(isImportId) ? 'playlist' : (mine.length ? 'packs' : null);

  /* Which tab is showing follows the room onto the tab its selection is on --
     but only on a *change* of kind, so a sync arriving while the host types a
     playlist link can't close the box under them. */
  const [tab, setTab] = useState(kind || 'packs');
  const lastKind = useRef(kind);
  useEffect(() => {
    if (kind && kind !== lastKind.current) setTab(kind);
    lastKind.current = kind;
  }, [kind]);

  const on = new Set(mine);
  const count = room.mix
    ? ((room.picks || []).find((p) => p.pid === me) || {}).count || 0
    : room.packCount || 0;
  const sum = kind === 'playlist'
    ? `playlist · ${num(count)} songs`
    : on.size ? `${plural(on.size, 'pack')} · ${num(count)} songs` : 'nothing picked';

  return (
    <section className="config">
      <div className="section-head">
        <h2>{room.mix ? 'Your songs' : 'Songs'}</h2>
        <span className="section-note">{sum}</span>
        <span className="spacer" />
        <div className="tabs" role="tablist" aria-label="Where the songs come from">
          <button type="button" role="tab" className="tab" aria-selected={tab === 'packs'} onClick={() => setTab('packs')}>Packs</button>
          <button type="button" role="tab" className="tab" aria-selected={tab === 'playlist'} onClick={() => setTab('playlist')}>Playlist link</button>
        </div>
        {isHost && !room.solo && (
          <button
            type="button"
            role="switch"
            aria-checked={!!room.mix}
            className={`switch${room.mix ? ' on' : ''}`}
            onClick={() => actions.setMix(!room.mix)}
          >
            <span className="switch-track" aria-hidden="true"><span className="switch-knob" /></span>
            Mix
          </button>
        )}
      </div>
      {sourceNoteFor(room, me, isHost) && <p className="section-sub">{sourceNoteFor(room, me, isHost)}</p>}

      {tab === 'packs' ? (
        <div className="pack-chips">
          {(packs || []).map((pack) => {
            const picked = on.has(pack.id);
            return (
              <button
                key={pack.id}
                type="button"
                aria-pressed={picked}
                className={`chip${picked ? ' on' : ''}`}
                title={`${pack.blurb} · ${num(pack.count)} songs`}
                onClick={() => actions.setPacks(toggledSelection(room, me, pack.id))}
              >
                {picked && <CheckIcon width="14" height="14" />}
                {pack.name}
              </button>
            );
          })}
          {!packs && <p className="hint">Loading packs…</p>}
        </div>
      ) : (
        <PlaylistImport imported={kind === 'playlist'} onImported={(id) => actions.setPacks([id])} />
      )}
    </section>
  );
}

/**
 * `playable` is a floor, not a total -- the server stops checking once it has
 * enough for a game -- so it reads "18+ of 50" rather than "18 of 50", which
 * would look like 32 failures.
 */
function describeImport(res) {
  const parts = [res.playableExact
    ? `all ${res.imported} songs playable`
    : `${res.playable}+ of ${res.imported} songs playable`];
  if (res.duplicates > 0) parts.push(`${plural(res.duplicates, 'duplicate')} merged`);
  if (res.truncated) parts.push('capped at the first 1,000');
  return `${res.name} — ${parts.join(', ')}.`;
}

function PlaylistImport({ imported, onImported }) {
  const [url, setUrl] = useState('');
  const [note, setNote] = useState({ text: '', tone: '' });
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  /* A success note describes a playlist that is in play. Once we have moved
     back to a pack it describes nothing. Failures stay: they are the reason
     nothing changed. */
  useEffect(() => {
    if (!imported) setNote((n) => (n.tone === 'ok' ? { text: '', tone: '' } : n));
  }, [imported]);

  async function run() {
    const link = url.trim();
    if (!link) {
      setNote({ text: 'Paste a playlist link first.', tone: 'bad' });
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setNote({ text: 'Importing…', tone: 'busy' });
    let res;
    let body;
    try {
      res = await fetch('/api/playlist/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: link })
      });
      body = await res.json();
    } catch {
      setBusy(false);
      setNote({ text: 'Could not reach the server. Try again.', tone: 'bad' });
      return;
    }
    setBusy(false);
    if (!res.ok) {
      setNote({ text: (body && body.error) || 'Import failed.', tone: 'bad' });
      return;
    }
    setNote({ text: describeImport(body), tone: 'ok' });
    // Handed to the room the same way a pack click is; the resulting state sync
    // is what actually switches the room over.
    onImported(body.id);
  }

  return (
    <div className="import">
      <div className="import-row">
        <label className="field">
          <span>Deezer or Spotify link</span>
          <input
            ref={inputRef}
            type="url"
            placeholder="https://www.deezer.com/playlist/..."
            autoComplete="off"
            spellCheck="false"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault(); // Enter in the lobby would otherwise fall through to chat
              run();
            }}
          />
        </label>
        <button type="button" className="btn tone-cream" disabled={busy} onClick={run}>Import</button>
      </div>
      {note.text && <p className={`note ${note.tone}`} role="status">{note.text}</p>}
    </div>
  );
}

/** One entry in the pool readout. */
function PoolChip({ icon, name, sub, idle }) {
  return (
    <span className={`pool-chip${idle ? ' idle' : ''}`}>
      <span className="pool-icon">{icon}</span>
      <span className="pool-meta">
        <b>{name}</b>
        {sub && <span>{sub}</span>}
      </span>
    </span>
  );
}

function selectionChips(ids, count, playlist, packById) {
  if (ids.some(isImportId)) {
    return [
      <PoolChip
        key="pl"
        icon={SOURCE_ICON[playlist && playlist.source] || 'PL'}
        name={(playlist && playlist.name) || 'Imported playlist'}
        sub={count ? `${num(count)} songs · evenly weighted` : 'imported playlist'}
      />
    ];
  }
  return ids.map((id) => {
    const pack = packById.get(id);
    return (
      <PoolChip
        key={id}
        icon={(pack && pack.icon) || '♪'}
        name={(pack && pack.name) || id}
        sub={pack ? `${num(pack.count)} songs` : ''}
      />
    );
  });
}

/**
 * What the room is playing, for everybody, in full.
 *
 * The settings line can only afford "All Time + 5 more", and the five it does
 * not name are exactly what somebody about to play wants to know. In a mix
 * every player gets a row of their own -- the host sees it too, since their
 * grid only shows their own picks.
 */
function Pool({ session }) {
  const { room, me, packs, hues } = session;
  const show = inLobby(room) && !room.daily && (room.mix || room.hostPid !== me);
  if (!show) return null;
  const packById = new Map((packs || []).map((p) => [p.id, p]));

  if (room.mix) {
    const picks = room.picks || [];
    const picked = picks.filter((p) => p.ids.length);
    return (
      <section className="config pool">
        <div className="section-head">
          <h2>Everyone's songs</h2>
          <span className="section-note">
            {plural(picked.length, 'selection')} · {num(room.packCount)} songs · equal turns
          </span>
        </div>
        <div className="pool-rows">
          {picks.map((pick) => (
            <div className="pool-row" key={pick.pid}>
              <span className="pool-who" style={{ color: hues(pick.pid) }}>
                {pick.pid === me ? `${pick.name} (you)` : pick.name}
              </span>
              <span className="pool-chips">
                {!pick.ids.length
                  ? <PoolChip icon="—" name="nothing picked yet" idle />
                  : pick.ids.some(isImportId)
                    ? <PoolChip icon="PL" name={pick.label} sub={`${num(pick.count)} songs`} />
                    : selectionChips(pick.ids, pick.count, null, packById)}
              </span>
            </div>
          ))}
        </div>
      </section>
    );
  }

  const ids = room.packIds || [];
  return (
    <section className="config pool">
      <div className="section-head">
        <h2>{room.playlist ? 'Playlist' : ids.length > 1 ? 'Song packs' : 'Song pack'}</h2>
        <span className="section-note">
          {room.playlist ? 'every song equally likely' : `${num(room.packCount)} songs`}
        </span>
      </div>
      <div className="pool-chips">{selectionChips(ids, room.packCount, room.playlist, packById)}</div>
    </section>
  );
}

/*
 * Difficulty picks which end of the pack songs come from -- see
 * server/difficulty.js. The server's value is the centre of a wide bell curve,
 * so neighbouring settings play nearly the same game; five named stops are the
 * choices that actually feel different. Each sends the middle of its band
 * (0-12 sends 6, 13-37 sends 25, and so on), so the default of 25 is simply
 * "Easy". A room already set between stops shows the band it falls in. It is
 * still a slider, just one that snaps to those five.
 */
function levelStops(levels) {
  let from = 0;
  return levels.map((level) => {
    const stop = { ...level, value: Math.round((from + level.upTo) / 2) };
    from = level.upTo + 1;
    return stop;
  });
}

function Difficulty({ session }) {
  const { room, diffLevels, actions } = session;
  const stops = diffLevels ? levelStops(diffLevels) : [];
  const indexOf = (value) => {
    const i = stops.findIndex((s) => value <= s.upTo);
    return i === -1 ? stops.length - 1 : i;
  };

  // Where the handle sits, as a stop index. It follows the room, except while
  // a value we sent is still on its way back -- a state sync crossing the drag
  // must not yank the handle out from under the player.
  const [index, setIndex] = useState(() => indexOf(room.difficulty));
  const pending = useRef(null);
  const levelsReady = stops.length > 0;
  useEffect(() => {
    if (!levelsReady) return;
    if (pending.current !== null) {
      if (room.difficulty !== pending.current) return;
      pending.current = null;
    }
    setIndex(indexOf(room.difficulty));
    // indexOf only depends on the levels, which levelsReady stands in for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.difficulty, levelsReady]);

  // React's onChange is the browser's `input` (every step of a drag); the
  // native `change` is the release, the only moment worth telling the room.
  const inputRef = useRef(null);
  const commit = useRef(null);
  commit.current = (i) => {
    const stop = stops[i];
    if (!stop || room.difficulty === stop.value) return;
    pending.current = stop.value;
    actions.setDifficulty(stop.value);
  };
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return undefined;
    const onRelease = () => commit.current(Number(el.value));
    el.addEventListener('change', onRelease);
    return () => el.removeEventListener('change', onRelease);
  }, [levelsReady]);

  const current = stops[index];
  const last = Math.max(1, stops.length - 1);

  return (
    <section className="config">
      <div className="section-head">
        <label htmlFor="diff"><h2>Difficulty</h2></label>
        <b className="diff-name">{current ? current.name : room.difficultyLabel}</b>
        {current && <span className="section-note">{current.blurb}</span>}
      </div>
      {levelsReady && (
        // The labels are laid out on the same line the thumb travels -- from
        // half a thumb in at one end to half a thumb in at the other -- so each
        // sits exactly under its stop.
        <div className="stop-slider" style={{ '--stops': last }}>
          <input
            ref={inputRef}
            id="diff"
            className="slider"
            type="range"
            min="0"
            max={last}
            step="1"
            value={index}
            aria-valuetext={current ? current.name : undefined}
            style={{ '--fill': `${(index / last) * 100}%` }}
            onChange={(e) => setIndex(Number(e.target.value))}
          />
          <div className="slider-scale">
            {stops.map((stop, i) => (
              <button
                key={stop.name}
                type="button"
                className={i === index ? 'on' : ''}
                style={{ '--at': i }}
                tabIndex={-1}
                onClick={() => {
                  setIndex(i);
                  commit.current(i);
                }}
              >
                {stop.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** Whole minutes, rounded, floored at one -- "about 0 min" says nothing. */
const describeLength = (rounds, paceMs) => `about ${Math.max(1, Math.round((rounds * paceMs) / 60000))} min`;

/**
 * The one thing a round count can promise and then fail to deliver: a game
 * needs as many playable songs as it has rounds. A pool that is plainly too
 * small can be seen coming; a game that ran short because previews could not
 * be found in time can only be reported afterwards.
 */
function roundsWarning(state, cfg) {
  const pool = state.packCount || 0;
  if (pool && cfg.value > pool) {
    return `Only ${num(pool)} songs to draw from — a game can run ${plural(pool, 'round')} at most.`;
  }
  const short = cfg.shortfall;
  if (short) {
    return `Last game managed ${short.got} of ${short.asked} rounds — previews for the `
      + 'rest could not be found in time. Try again, or pick a broader pool.';
  }
  return '';
}

function Rounds({ session }) {
  const { room, actions } = session;
  const cfg = room.roundConfig || { value: room.totalRounds, min: 3, max: 20, paceMs: 40000 };
  const [pending, setPending] = useState(null);
  useEffect(() => {
    if (pending !== null && cfg.value === pending) setPending(null);
  }, [cfg.value, pending]);
  const shown = pending ?? cfg.value;
  const warning = roundsWarning(room, cfg);

  return (
    <section className="config">
      <div className="section-head">
        <h2>Rounds</h2>
        <span className="section-note">{describeLength(shown, cfg.paceMs)}</span>
      </div>
      <div className="round-stops" role="group" aria-label="Rounds per game">
        {ROUND_STOPS.filter((n) => n >= cfg.min && n <= cfg.max).map((stop) => (
          <button
            key={stop}
            type="button"
            aria-pressed={stop === shown}
            className={`stop mono${stop === shown ? ' on' : ''}`}
            onClick={() => {
              setPending(stop);
              actions.setRounds(stop);
            }}
          >
            {stop}
          </button>
        ))}
      </div>
      {warning && <p className="note bad" role="status">{warning}</p>}
    </section>
  );
}

function SettingsLine({ room, modes }) {
  const bits = [
    modeLabel(modes, room.mode),
    room.packName,
    plural(room.totalRounds, 'round'),
    // Difficulty genuinely does not apply to an imported playlist.
    room.equalWeight ? 'even weighting' : room.difficultyLabel,
    ...(room.solo ? [] : [`${room.maxPlayers} max`, room.hasPassword ? 'password on' : null])
  ].filter(Boolean);
  return <p className="settings-line">{bits.join(' · ')}</p>;
}
