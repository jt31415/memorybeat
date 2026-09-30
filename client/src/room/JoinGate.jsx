import { useEffect, useRef, useState } from 'react';
import { savedName, savedPassword } from '../lib/storage.js';

/*
 * The door into a room. Its backdrop is up from the first paint until we are
 * in, so the lobby is never briefly clickable underneath -- but the panel only
 * appears once we know this is a room somebody has to knock on (a solo game
 * lets itself in, and never shows it at all unless the join fails).
 */
export default function JoinGate({ session }) {
  const { gate, code, actions } = session;
  const [name, setName] = useState(savedName);
  const [password, setPassword] = useState(() => savedPassword(code));
  const nameRef = useRef(null);
  const goRef = useRef(null);
  const passRef = useRef(null);

  useEffect(() => {
    if (gate.phase !== 'open') return;
    const t = setTimeout(() => {
      if (gate.needPassword && !password) passRef.current?.focus();
      else if (gate.daily || name) goRef.current?.focus();
      else nameRef.current?.focus();
    }, 50);
    return () => clearTimeout(t);
    // Only on opening, and when a password turns out to be needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate.phase, gate.needPassword]);

  if (gate.phase === 'hidden') return null;

  const go = () => actions.join(gate.daily ? '' : name.trim(), password);
  const onKey = (e) => { if (e.key === 'Enter') go(); };

  return (
    <div className="overlay">
      {gate.phase === 'open' && (
        <section className="gate" role="dialog" aria-modal="true" aria-labelledby="gate-title">
          <h1 id="gate-title">{gate.title}</h1>
          <p className="hint">{gate.sub}</p>

          {!gate.daily && (
            <div className="field">
              <label htmlFor="join-name">Your name</label>
              <input
                id="join-name"
                ref={nameRef}
                type="text"
                maxLength={16}
                placeholder="DJ Anon"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={onKey}
              />
            </div>
          )}

          {gate.needPassword && (
            <div className="field">
              <label htmlFor="join-pass">Room password</label>
              <input
                id="join-pass"
                ref={passRef}
                type="password"
                maxLength={40}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={onKey}
              />
            </div>
          )}

          <button ref={goRef} type="button" className="btn btn-xl tone-tangerine btn-block" disabled={gate.busy} onClick={go}>
            {gate.daily ? "Start today's challenge" : name ? 'Enter room' : 'Join'}
          </button>
          {gate.error && <p className="error" role="alert">{gate.error}</p>}
          <a className="gate-back" href={gate.daily ? '/daily' : '/'}>{gate.daily ? 'Back to the daily' : 'Back to menu'}</a>
        </section>
      )}
    </div>
  );
}
