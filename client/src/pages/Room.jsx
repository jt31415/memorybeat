import { useEffect, useRef, useState } from 'react';
import { Wordmark } from '../components/common.jsx';
import { VolumeIcon } from '../components/glyphs.jsx';
import { useRoomSession } from '../room/useRoomSession.js';
import { NARROW_QUERY, trackViewportInsets } from '../lib/viewport.js';
import Lobby from '../room/Lobby.jsx';
import Play from '../room/Play.jsx';
import Final from '../room/Final.jsx';
import Sidebar from '../room/Sidebar.jsx';
import JoinGate from '../room/JoinGate.jsx';

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/* Room page: lobby, rounds, audio, visualiser, scores and chat. */
export default function Room({ code }) {
  const session = useRoomSession(code);
  const { room, round, view, gate, guessLive, actions, attachAudio } = session;
  const narrow = useMediaQuery(NARROW_QUERY);
  const chatRef = useRef(null);
  const guessRef = useRef(null);
  const [guessText, setGuessText] = useState('');

  const solo = !!(room && room.solo);
  const choosing = !!(round && round.mode === 'choice');
  // Solo has no sidebar to type into; on a phone the chat box is a screen and a
  // half below the stage. Either way the answer box is pinned to the stage.
  const barred = solo || narrow;

  useEffect(() => trackViewportInsets(), []);

  /* A guess still sitting in the solo box when the round ends belongs to a song
     that is over -- clear it so the next round starts on an empty box. (In a
     room the box doubles as chat, and a half-written message is kept.) */
  const revealed = !!(round && round.reveal);
  useEffect(() => {
    if (revealed && solo) setGuessText('');
  }, [revealed, solo]);

  useEffect(() => {
    document.title = room && room.daily ? 'MemoryBeat — Daily challenge'
      : solo ? 'MemoryBeat — Solo' : `MemoryBeat — Room ${code}`;
  }, [room, solo, code]);

  /* Focus the answer box when a round goes live -- never on a phone, where it
     would throw the keyboard up over half the screen every round. */
  useEffect(() => {
    if (!guessLive || narrow || choosing || (round && round.solved)) return;
    const box = barred ? guessRef.current : chatRef.current;
    if (box && document.activeElement !== box) box.focus();
  }, [guessLive, narrow, barred, choosing, round]);

  /* Number keys pick a card, and anywhere you start typing, you are typing a
     guess. */
  const keyState = useRef({});
  keyState.current = { round, gate, barred, choose: actions.choose };
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const { round: r, gate: g, barred: b, choose } = keyState.current;
      if (g.phase !== 'hidden') return; // still at the join gate
      const active = document.activeElement;
      const typing = active && /^(INPUT|TEXTAREA)$/.test(active.tagName);

      // In a multiple-choice round the digits belong to the cards, always --
      // before the pick, after it, and between rounds. Letting one fall through
      // to the typing-anywhere rule below would throw focus into the chat, and
      // every hotkey after that would land in the message box.
      if (r && r.mode === 'choice' && !typing && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const n = Number(e.key);
        if (r.picked == null && r.choices && n <= r.choices.length) choose(n - 1);
        return;
      }
      if (typing || e.key.length !== 1) return;
      const box = b ? guessRef.current : chatRef.current;
      if (box && !box.disabled) box.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const inPlay = view === 'play';

  return (
    <div className={`room${solo ? ' solo' : ''}${inPlay ? ' in-play' : ''}${inPlay && barred && !choosing ? ' bar-input' : ''}`}>
      <section className="stage">
        <TopBar session={session} />
        <div className="stage-body">
          {view === 'lobby' && <Lobby session={session} />}
          {view === 'play' && (
            <Play session={session} guessRef={guessRef} barred={barred} guessText={guessText} setGuessText={setGuessText} />
          )}
          {view === 'final' && <Final session={session} />}
        </div>
      </section>

      {!solo && <Sidebar session={session} chatRef={chatRef} hideChatForm={inPlay && barred && !choosing} />}

      <JoinGate session={session} />
      <audio ref={attachAudio} preload="auto" />
    </div>
  );
}

function TopBar({ session }) {
  const { room, round, view, code, volume, actions } = session;
  const label = room && room.daily ? 'Daily' : room && room.solo ? 'Solo' : code;
  const level = volume.level === 0 ? 'off' : volume.level < 0.45 ? 'low' : 'high';
  const total = round ? round.total : 0;

  return (
    <header className="topbar">
      <Wordmark className="small" />
      <span className="code-chip mono">{label}</span>
      {room && <span className="topbar-pack">{room.packName}</span>}
      <span className="spacer" />
      {view === 'play' && round && (
        <span className="round-progress" aria-label={`Round ${round.index + 1} of ${total}`}>
          {total <= 20 && (
            <span className="pips" aria-hidden="true">
              {Array.from({ length: total }, (_, i) => (
                <span key={i} className={i < round.index ? 'done' : i === round.index ? 'now' : ''} />
              ))}
            </span>
          )}
          <span className="mono">{round.index + 1}<span className="faint">/{total}</span></span>
        </span>
      )}
      {view === 'play' && round && round.phase === 'reveal' && (
        <span className="topbar-clock">{session.clock.label}</span>
      )}
      <span className="volume">
        <button
          type="button"
          className="icon-btn"
          aria-label={level === 'off' ? 'Unmute' : 'Mute'}
          title={level === 'off' ? 'Unmute' : 'Mute'}
          onClick={actions.toggleMute}
        >
          <VolumeIcon level={level} width="20" height="20" />
        </button>
        <input
          type="range"
          min="0"
          max="100"
          aria-label="Volume"
          value={Math.round(volume.level * 100)}
          style={{ '--fill': `${Math.round(volume.level * 100)}%` }}
          onChange={(e) => actions.setVolume(Number(e.target.value) / 100)}
        />
      </span>
      <button type="button" className="btn btn-quiet small" onClick={actions.leave}>Leave</button>
    </header>
  );
}
