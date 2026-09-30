import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { Wordmark, DiscordAvatar, Avatar } from '../components/common.jsx';
import { BeamedNotes, EighthNote } from '../components/glyphs.jsx';
import { playerId, savedName, saveName, savePassword } from '../lib/storage.js';
import { countdown, num, readCode } from '../lib/format.js';
import { useDaily, useNow, signOut } from '../lib/useDaily.js';
import { PLAYER_HUES } from '../lib/hues.js';

/*
 * The front door: a name, then one tap to whichever way you want to play.
 *
 * Deliberately thin. Song packs, playlists and every other game setting live
 * in the room lobby, where the host picks them between games with everyone
 * watching -- choosing songs before anyone has joined is the wrong moment. So
 * a room is created with a default pack (see packs.defaultSelection) and
 * changed from the lobby.
 */

/* The decoration: a few big notes in the empty corners, never behind text. */
const NOTES = [
  { Glyph: BeamedNotes, className: 'note-a' },
  { Glyph: EighthNote, className: 'note-b' },
  { Glyph: EighthNote, className: 'note-c' }
];

export default function Home() {
  const { data } = useDaily();
  const now = useNow(!!data);
  const socketRef = useRef(null);

  const [name, setName] = useState(savedName);
  const [code, setCode] = useState('');
  const [options, setOptions] = useState(false);
  const [maxPlayers, setMaxPlayers] = useState(8);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState({ where: '', text: '' });

  const nameRef = useRef(null);
  const codeRef = useRef(null);

  useEffect(() => {
    const socket = io();
    socketRef.current = socket;
    return () => socket.disconnect();
  }, []);

  const fail = (where, text, focus) => {
    setError({ where, text });
    if (focus) focus.current?.focus();
  };

  /**
   * No packIds are sent. The server seats a new room on a default pack, and
   * the lobby is where it gets changed -- see server/index.js room:create.
   */
  function createRoom(opts, where) {
    setBusy(where);
    setError({ where: '', text: '' });
    // A request the server never answers must not leave the button spinning.
    socketRef.current.timeout(10000).emit('room:create', { ...opts, pid: playerId() }, (err, res) => {
      if (err || !res || res.error) {
        setBusy('');
        fail(where, err
          ? 'Could not reach the server. Check your connection and try again.'
          : (res && res.error) || 'Something went wrong. Try again.');
        return;
      }
      if (opts.password) savePassword(res.code, opts.password);
      location.href = `/r/${res.code}`;
    });
  }

  function playSolo() {
    const who = name.trim() || savedName() || 'You';
    saveName(who);
    createRoom({ solo: true }, 'solo');
  }

  function create() {
    const who = name.trim();
    if (!who) return fail('friends', 'Pick a name first.', nameRef);
    saveName(who);
    createRoom({ solo: false, maxPlayers: Number(maxPlayers) || 8, password }, 'friends');
  }

  function join() {
    const who = name.trim();
    if (!who) return fail('friends', 'Pick a name first.', nameRef);
    const room = readCode(code);
    if (room.length !== 4) return fail('friends', 'A room code is four letters.', codeRef);
    saveName(who);
    // Whether the room exists, and whether it wants a password, is the room
    // page's question -- it has to ask it on every arrival anyway, since most
    // people get there from a shared link rather than from this box.
    location.href = `/r/${room}`;
  }

  /* Typed codes are uppercased in place and stripped of anything that cannot
     be in one. A pasted link is left alone until Join, since rewriting it
     under the cursor mid-paste is worse than letting it sit for a moment. */
  function onCode(e) {
    const raw = e.target.value;
    setError({ where: '', text: '' });
    if (/[/:.]/.test(raw)) return setCode(raw);
    setCode(raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4));
  }

  /* Enter in the name box does whichever friends action is ready: join if a
     code is in, create if not. */
  function onNameKey(e) {
    if (e.key !== 'Enter') return;
    if (readCode(code).length === 4) join();
    else create();
  }

  const available = data && data.available;
  const today = (data && data.boards && data.boards.today) || [];

  return (
    <div className="home">
      {NOTES.map(({ Glyph, className }) => <Glyph key={className} className={`home-note ${className}`} />)}

      <header className="home-top">
        {available && (data.user ? (
          <div className="whoami">
            <DiscordAvatar src={data.user.avatar} size={30} />
            <span className="whoami-name">{data.user.name}</span>
            <button type="button" className="btn-quiet small" onClick={signOut}>Sign out</button>
          </div>
        ) : (
          <a className="btn btn-discord" href={`/auth/discord?returnTo=${encodeURIComponent('/')}`}>
            Sign in with Discord
          </a>
        ))}
      </header>

      <main className="home-main">
        <h1 className="home-title"><Wordmark href={null} bars={5} className="live" /></h1>
        <p className="home-tagline">Hear a clip. Name the song before anyone else.</p>

        <div className="field home-name">
          <label htmlFor="nick">Your name</label>
          <input
            id="nick"
            ref={nameRef}
            type="text"
            maxLength={16}
            placeholder="DJ Anon"
            autoComplete="off"
            value={name}
            onChange={(e) => { setName(e.target.value); setError({ where: '', text: '' }); }}
            onKeyDown={onNameKey}
          />
        </div>

        <div className="home-modes">
          <a className="mode-btn tone-tangerine" href="/daily">
            <span className="mode-btn-title">Daily challenge</span>
            <span className="mode-btn-sub">
              {!data ? ' ' : !available ? 'Needs Discord sign-in'
                : data.played ? `You scored ${num(data.played.score)} · #${data.played.rank}`
                  : <>{data.rounds} songs · <span className="mono">{countdown(data.resetsAt, now)}</span> left</>}
            </span>
          </a>
          <button type="button" className="mode-btn tone-butter" onClick={playSolo} disabled={busy === 'solo'}>
            <span className="mode-btn-title">{busy === 'solo' ? 'Starting…' : 'Play solo'}</span>
            <span className="mode-btn-sub">Beat your best score</span>
          </button>
        </div>
        {error.where === 'solo' && <p className="error" role="alert">{error.text}</p>}

        <section className="friends" aria-labelledby="friends-label">
          <div className="friends-head">
            <h2 id="friends-label" className="field-label">Play with friends</h2>
            <button
              type="button"
              className="link-btn"
              aria-expanded={options}
              onClick={() => setOptions((o) => !o)}
            >
              Room options
            </button>
          </div>
          <div className="friends-panel">
            <button type="button" className="btn btn-lg tone-aqua friends-create" onClick={create} disabled={busy === 'friends'}>
              {busy === 'friends' ? 'Creating…' : 'Create room'}
            </button>
            <span className="friends-or">or</span>
            <div className="friends-join">
              <input
                ref={codeRef}
                className="code-input"
                type="text"
                aria-label="Room code"
                placeholder="CODE"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck="false"
                value={code}
                onChange={onCode}
                onKeyDown={(e) => { if (e.key === 'Enter') join(); }}
              />
              <button type="button" className="btn btn-lg tone-rose" onClick={join}>Join</button>
            </div>
          </div>
          {options && (
            <div className="friends-options">
              <label className="field">
                <span>Max players</span>
                <input type="number" min="2" max="20" value={maxPlayers} onChange={(e) => setMaxPlayers(e.target.value)} />
              </label>
              <label className="field">
                <span>Password <em>(optional)</em></span>
                <input
                  type="password"
                  maxLength={40}
                  placeholder="none"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            </div>
          )}
          {error.where === 'friends' && <p className="error" role="alert">{error.text}</p>}
        </section>
      </main>

      {available && (
        <aside className="home-board" aria-labelledby="home-board-title">
          <div className="home-board-head">
            <h2 id="home-board-title">Today's daily</h2>
          </div>
          {today.length ? (
            <ol className="mini-board">
              {today.slice(0, 5).map((entry, i) => (
                <li key={entry.id} className={data.user && entry.id === data.user.id ? 'me' : ''}>
                  <span className={`rank rank-${i + 1}`}>{i + 1}</span>
                  {entry.avatar
                    ? <DiscordAvatar src={entry.avatar} size={24} />
                    : <Avatar name={entry.name} color={PLAYER_HUES[i]} size={24} label={false} />}
                  <span className="who">{entry.name}</span>
                  <span className="score">{num(entry.score)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="hint">Nobody has finished today's challenge yet. Be first.</p>
          )}
          <a className="link" href="/daily">See the full board</a>
        </aside>
      )}

      <footer className="credits">Made by Nisc_ and jt314</footer>
    </div>
  );
}
