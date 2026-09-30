import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Avatar } from '../components/common.jsx';
import { CrossIcon } from '../components/glyphs.jsx';
import { useNow } from '../lib/useDaily.js';

/* The room's side rail: the standings, a kick vote when there is one, and chat. */
export default function Sidebar({ session, chatRef, hideChatForm }) {
  const [kickAsking, setKickAsking] = useState(null);
  const { room } = session;
  return (
    <aside className="sidebar">
      <div className="side-head">
        <h2>Players</h2>
        <span className="section-note mono">
          {room ? `${room.players.filter((p) => p.connected).length}/${room.maxPlayers}` : ''}
        </span>
      </div>
      {room && <KickBar session={session} asking={kickAsking} setAsking={setKickAsking} />}
      {room && <Scoreboard session={session} onAskKick={(pid) => setKickAsking((a) => (a === pid ? null : pid))} />}
      <Chat session={session} inputRef={chatRef} hideForm={hideChatForm} />
    </aside>
  );
}

/*
 * The standings. Rows are keyed by player and kept across renders, so a change
 * in rank can be animated: measure where every row was, let React reorder, then
 * slide each row from its old place to its new one (FLIP). Ranks that teleport
 * are exactly the moment you most want to see.
 */
function Scoreboard({ session, onAskKick }) {
  const { room, me, round, hues } = session;
  const rows = useRef(new Map());
  const tops = useRef(new Map());
  const lastScore = useRef(new Map());
  // pid -> the score that last rose. The pulse belongs to that score, so it
  // plays once when the number changes and survives unrelated re-renders.
  const risen = useRef(new Map());
  const order = room.players.map((p) => p.pid).join('|');

  useLayoutEffect(() => {
    const next = new Map();
    for (const [pid, el] of rows.current) {
      if (!el) continue;
      const top = el.getBoundingClientRect().top;
      next.set(pid, top);
      const was = tops.current.get(pid);
      if (was == null) continue;
      const dy = was - top;
      if (Math.abs(dy) < 1) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = '';
        el.style.transform = '';
      });
    }
    tops.current = next;
  }, [order]);

  // Remember what each score was, so the next render can tell a rise from a
  // repaint. Read during render, written after it.
  useEffect(() => {
    lastScore.current = new Map(room.players.map((p) => [p.pid, p.score]));
  });

  const solvedPoints = new Map();
  if (round && round.reveal) {
    for (const r of round.reveal.results) solvedPoints.set(r.pid, r.points);
  }

  return (
    <ol className="scores">
      {room.players.map((p, i) => {
        const prev = lastScore.current.get(p.pid);
        if (prev != null && p.score > prev) risen.current.set(p.pid, p.score);
        const bumped = risen.current.get(p.pid) === p.score;
        // No ✕ on your own row, none while a vote is already running, and none
        // for somebody who has already dropped out -- the server refuses all three.
        const canKick = !room.solo && !room.kickVote && p.pid !== me && p.connected !== false;
        const pts = solvedPoints.get(p.pid);
        return (
          <li
            key={p.pid}
            ref={(el) => {
              if (el) rows.current.set(p.pid, el);
              else rows.current.delete(p.pid);
            }}
            className={`score-row${p.pid === me ? ' you' : ''}${p.connected === false ? ' away' : ''}`}
          >
            <span className={`rank${i === 0 ? ' lead' : ''}`}>{i + 1}</span>
            <Avatar name={p.name} color={hues(p.pid)} size={30} />
            <span className="nm">{p.pid === me ? `${p.name} (you)` : p.name}</span>
            {p.answered && !(round && round.reveal) && (
              <span className="answered" style={{ color: hues(p.pid) }} aria-label="answered">●</span>
            )}
            {pts > 0 && <span className="gain mono" style={{ color: hues(p.pid) }}>+{pts}</span>}
            <span key={p.score} className={`pts mono${bumped ? ' bumped' : ''}`}>
              {Number(p.score).toLocaleString('en-US')}
            </span>
            {canKick && (
              <button
                type="button"
                className="kick"
                title={`Remove ${p.name}`}
                aria-label={`Remove ${p.name}`}
                onClick={() => onAskKick(p.pid)}
              >
                <CrossIcon width="14" height="14" />
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/*
 * Getting somebody out of the room. The server owns all of it (see
 * Room#startKick): who may propose, what carries it, and whether the host
 * simply decides. The ✕ on a row never kicks on its own -- a one-click misfire
 * would be unrecoverable -- so it opens this bar, and the bar has the button
 * that means it.
 */
function KickBar({ session, asking, setAsking }) {
  const { room, me, actions } = session;
  const vote = room.kickVote;
  const now = useNow(!!vote);

  // A vote outranks our own half-finished proposal -- somebody got there first.
  useEffect(() => {
    if (vote && asking) setAsking(null);
  }, [vote, asking, setAsking]);

  if (room.solo || (!vote && !asking)) return null;

  if (vote) {
    const left = Math.max(0, Math.ceil((vote.endsAt - now) / 1000));
    const line = vote.targetPid === me
      ? `The room is voting on removing you — ${left}s`
      : `Remove ${vote.targetName}? ${vote.yes} of ${vote.needed} · ${left}s`;
    const canVote = vote.targetPid !== me && !vote.voted.includes(me);
    return (
      <div className="kick-bar live" role="status">
        <span>{line}</span>
        {canVote && (
          <span className="kick-acts">
            <button type="button" className="btn small tone-rose" onClick={() => actions.kickVote(true)}>Remove</button>
            <button type="button" className="btn small btn-quiet" onClick={() => actions.kickVote(false)}>Keep</button>
          </span>
        )}
      </div>
    );
  }

  const isHost = room.hostPid === me;
  const target = room.players.find((p) => p.pid === asking);
  const who = target ? target.name : 'them';
  // A vote needs two people who are not its subject. The server refuses this
  // anyway, but its refusal would land nowhere near the button that caused it.
  const voters = room.players.filter((p) => p.connected !== false && p.pid !== asking).length;

  if (!isHost && voters < 2) {
    return (
      <div className="kick-bar" role="status">
        <span>There is nobody else here to vote with you on removing {who}.</span>
        <span className="kick-acts">
          <button type="button" className="btn small btn-quiet" onClick={() => setAsking(null)}>OK</button>
        </span>
      </div>
    );
  }

  return (
    <div className="kick-bar" role="status">
      <span>{isHost ? `Remove ${who} from the room?` : `Ask the room to remove ${who}?`}</span>
      <span className="kick-acts">
        <button
          type="button"
          className="btn small tone-rose"
          onClick={() => {
            actions.kick(asking);
            setAsking(null);
          }}
        >
          {isHost ? 'Remove' : 'Start vote'}
        </button>
        <button type="button" className="btn small btn-quiet" onClick={() => setAsking(null)}>Cancel</button>
      </span>
    </div>
  );
}

/*
 * The log carries three different sorts of thing and they need to read
 * differently at a glance: ordinary talk, a solve, and the answer. Joins and
 * leaves are housekeeping and stay out of the way. Everything is rendered as
 * text -- some of it is another player's typing.
 */
function Message({ msg, hues, me }) {
  if (msg.nudge) return <div className="msg nudge">{msg.text}</div>;

  if (msg.system) {
    if (msg.kind === 'solve') {
      const color = hues(msg.pid);
      return (
        <div className="msg solve" style={{ color }}>
          <span className="solve-dot" style={{ background: color }} aria-hidden="true" />
          <span>{msg.pid === me ? 'You' : msg.name || 'Someone'} got it</span>
          {typeof msg.seconds === 'number' && <span className="mono solve-time">{msg.seconds.toFixed(1)}s</span>}
        </div>
      );
    }
    if (msg.kind === 'answer') {
      return (
        <div className="msg answer">
          <span className="answer-kicker">The song was</span>
          <b>{msg.title}</b>
          {msg.artist && <span>by {msg.artist}</span>}
        </div>
      );
    }
    const name = msg.name && msg.text && msg.text.startsWith(msg.name) ? msg.name : null;
    return (
      <div className="msg sysline">
        {name ? (
          <><b style={{ color: hues(msg.pid) }}>{name}</b> {msg.text.slice(name.length).trim()}</>
        ) : msg.text}
      </div>
    );
  }

  return (
    <div className={`msg${msg.private ? ' private' : ''}`}>
      <b style={{ color: hues(msg.pid) }}>{msg.name}</b> <span className="msg-text">{msg.text}</span>
      {msg.private && <span className="lock">solvers only</span>}
    </div>
  );
}

function Chat({ session, inputRef, hideForm }) {
  const { messages, hues, me, chatNote, guessLive, round, actions } = session;
  const [text, setText] = useState('');
  const logRef = useRef(null);
  const nearBottom = useRef(true);

  // Follow new messages only for someone already at the bottom -- scrolling
  // back to read something should not be yanked away by the next line.
  useLayoutEffect(() => {
    const log = logRef.current;
    if (log && nearBottom.current) log.scrollTop = log.scrollHeight;
  }, [messages]);

  const choosing = !!(round && round.mode === 'choice');
  const solved = !!(round && round.solved);
  const guessing = guessLive && !solved && !choosing;
  const placeholder = guessing
    ? 'Type your guess…'
    : solved && !choosing && round && !round.reveal ? 'Chat with the others who got it…' : 'Say something…';

  return (
    <div className="chat">
      <div className="side-head">
        <h2>Chat</h2>
        {guessing && <span className="guessing">Guessing</span>}
      </div>
      <div
        ref={logRef}
        className="chat-log"
        role="log"
        aria-live="polite"
        aria-label="Chat"
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {messages.map((m) => <Message key={m.id} msg={m} hues={hues} me={me} />)}
      </div>
      {chatNote && (
        <p className="chat-note">You're solved, so only other solvers see your messages until the round ends.</p>
      )}
      {!hideForm && (
        <form
          className="chat-form"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            actions.say(text);
            setText('');
          }}
        >
          <input
            ref={inputRef}
            type="text"
            maxLength={240}
            aria-label="Message"
            placeholder={placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="btn tone-cream">Send</button>
        </form>
      )}
    </div>
  );
}
