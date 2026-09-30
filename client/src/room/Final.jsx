import { useEffect, useRef, useState } from 'react';
import { Avatar } from '../components/common.jsx';
import { CrownIcon, EighthNote, ShareIcon } from '../components/glyphs.jsx';
import { nextDailyAt, num, plural, secs } from '../lib/format.js';
import { copyText, shareText } from '../lib/share.js';
import { modeLabel } from './Lobby.jsx';

/*
 * The end of a game: who won, the three things a points column hides, and
 * every song that was played.
 *
 * It arrives as a sequence rather than all at once -- the podium builds from
 * third place up, the scores count, the crown lands last -- so the one screen
 * everybody looks at together has a moment to it.
 */
export default function Final({ session }) {
  const { summary, room, me, hues, modes, actions } = session;
  if (!summary) return <div className="final" />;

  const { leaderboard = [], songs = [], totalRounds } = summary;
  const solo = summary.solo != null ? !!summary.solo : !!(room && room.solo);
  const rounds = songs.length || totalRounds || 0;
  const isHost = room && room.hostPid === me;
  const isDaily = !!(room && room.daily) || !!summary.daily;
  const winner = leaderboard[0];
  const mineSolved = songs.filter((s) => s.solvers.some((x) => x.pid === me)).length;

  const headline = solo
    ? (winner ? <><CountUp value={winner.score} duration={1200} /> points</> : 'Game over')
    : !winner ? 'Game over'
      // First place on zero points is a tie nobody won.
      : !winner.score ? 'Nobody scored'
        : winner.pid === me ? 'You win!' : `${winner.name} wins`;

  const sub = [
    plural(rounds, 'song'),
    summary.packName,
    summary.difficultyLabel,
    summary.mode ? modeLabel(modes, summary.mode) : null
  ].filter(Boolean).join(' · ');

  const honors = solo ? [] : buildHonors(leaderboard, summary.fastest);

  const recap = (
    <>
      <div className="section-head">
        <h2>Songs this game</h2>
        <span className="section-note">
          {solo ? `${mineSolved} of ${songs.length} solved` : `you got ${mineSolved} of ${songs.length}`}
          {summary.missed ? ` · ${summary.missed} unsolved` : ''}
        </span>
      </div>
      <ol className="recap">
        {songs.map((song, i) => <SongRow key={song.round} index={i} song={song} solo={solo} me={me} hues={hues} />)}
      </ol>

      {summary.daily && (
        <p className="hint">
          {summary.daily.recorded
            ? `Your run is on today's leaderboard. Next five songs at ${nextDailyAt()}.`
            : "You'd already finished today's challenge, so this run wasn't counted."}
        </p>
      )}

      <div className="final-actions">
        {summary.daily && summary.daily.result && <ShareButton day={summary.daily.day} result={summary.daily.result} />}
        {isHost && !isDaily && (
          <button type="button" className="btn btn-xl tone-tangerine grow" onClick={actions.again}>Play again</button>
        )}
        <a className="btn btn-xl btn-quiet" href={isDaily ? '/daily' : '/'}>{isDaily ? 'Daily challenge' : 'Main menu'}</a>
      </div>
    </>
  );

  /* On your own there is no podium and nobody to honour, so everything stacks
     down one centred column: the score, how it was made, and the songs. */
  if (solo) {
    return (
      <div className="final solo">
        <div className="final-head">
          <h1>{headline}</h1>
          <p>{sub}</p>
        </div>
        <SoloStats entry={winner} rounds={rounds} />
        <section className="final-songs">{recap}</section>
      </div>
    );
  }

  return (
    <div className="final">
      <section className="final-left">
        <div className="final-head">
          <h1>{headline}</h1>
          <p>{sub}</p>
        </div>

        <Podium entries={leaderboard.slice(0, 3)} me={me} hues={hues} />
        {leaderboard.length > 3 && (
          <ol className="final-rest" start={4}>
            {leaderboard.slice(3).map((e, i) => (
              <li key={e.pid} className={e.pid === me ? 'you' : ''} style={{ '--i': i }}>
                <span className="rank mono">{e.rank}</span>
                <Avatar name={e.name} color={hues(e.pid)} size={26} />
                <span className="nm">
                  {e.pid === me ? `${e.name} (you)` : e.name}
                  {e.correct != null && <small>{statLine(e, rounds, false).join(' · ')}</small>}
                </span>
                <span className="mono pts"><CountUp value={e.score} delay={900} /></span>
              </li>
            ))}
          </ol>
        )}

        {honors.length > 0 && (
          <div className="honors">
            {honors.map((h, i) => (
              <div className="honor" key={h.cap} style={{ '--i': i }}>
                <span className="honor-cap">{h.cap}</span>
                <span className="honor-row">
                  <span className="honor-value" style={{ color: hues(h.pid) }}>{h.value}</span>
                  <Avatar name={h.name} color={hues(h.pid)} size={22} label={false} />
                  <b>{h.pid === me ? 'You' : h.name}</b>
                </span>
                <span className="honor-sub">{h.sub}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="final-right">{recap}</section>
    </div>
  );
}

/** A number that counts up to its value, once, after an optional delay. */
function CountUp({ value, delay = 0, duration = 900 }) {
  const [shown, setShown] = useState(0);
  const target = useRef(value);
  target.current = value;
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(target.current);
      return undefined;
    }
    let raf = 0;
    const begin = performance.now() + delay;
    const step = (now) => {
      const t = Math.max(0, Math.min(1, (now - begin) / duration));
      // ease-out: quick at first, settling onto the number
      setShown(Math.round(target.current * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [delay, duration]);
  return num(shown);
}

/**
 * The line under each name: how much of the game they actually got. Only the
 * parts that mean something are shown -- "0 firsts" and a one-round streak say
 * nothing.
 */
function statLine(entry, rounds, solo) {
  const parts = [`${entry.correct}/${rounds} correct`];
  if (!solo && entry.firsts) parts.push(plural(entry.firsts, 'first'));
  if (entry.streak > 1) parts.push(`streak ${entry.streak}`);
  if (entry.avgMs != null) parts.push(`avg ${secs(entry.avgMs)}`);
  if (entry.bestMs != null && entry.correct > 1) parts.push(`best ${secs(entry.bestMs)}`);
  return parts;
}

function SoloStats({ entry, rounds }) {
  if (!entry) return null;
  const parts = entry.correct == null ? [] : statLine(entry, rounds, true);
  return (
    <div className="solo-stats">
      {parts.map((p) => <span key={p} className="solo-stat">{p}</span>)}
    </div>
  );
}

/* When each step's score starts counting: third place first, the winner last,
   matching the order the blocks rise in (see .podium-col in styles.css). */
const PODIUM_DELAY = { 3: 350, 2: 550, 1: 750 };

/* Second, first, third -- the winner in the middle, standing tallest. */
function Podium({ entries, me, hues }) {
  const order = entries.length >= 3 ? [entries[1], entries[0], entries[2]]
    : entries.length === 2 ? [entries[1], entries[0]] : entries;
  const HEIGHT = { 1: 200, 2: 150, 3: 110 };
  return (
    <div className="podium">
      {order.map((e) => (
        <div key={e.pid} className={`podium-col place-${e.rank}`} style={{ '--hue': hues(e.pid) }}>
          {e.rank === 1 && <CrownIcon className="podium-crown" aria-label="Winner" />}
          <Avatar name={e.name} color={hues(e.pid)} size={e.rank === 1 ? 96 : 76} ring={e.pid === me} />
          <span className="podium-name">{e.pid === me ? `${e.name} (you)` : e.name}</span>
          <div className="podium-block" style={{ height: HEIGHT[e.rank] || 90 }}>
            <span className="podium-place">{e.rank}</span>
            <span className="mono"><CountUp value={e.score} delay={PODIUM_DELAY[e.rank] || 0} /></span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The awards. Each is skipped rather than shown empty: a "most firsts" card
 * reading 0 is noise, and an average over one correct answer is not an
 * average. Leaderboard order breaks ties.
 */
function buildHonors(leaderboard, fastest) {
  if (leaderboard.length < 2) return [];
  const cards = [];

  const most = leaderboard.reduce((a, b) => ((b.firsts || 0) > (a?.firsts || 0) ? b : a), null);
  if (most && most.firsts) {
    cards.push({
      cap: 'Most firsts',
      value: String(most.firsts),
      name: most.name,
      pid: most.pid,
      sub: `beat everyone to ${most.firsts === 1 ? 'a song' : `${most.firsts} songs`}`
    });
  }
  if (fastest) {
    cards.push({ cap: 'Fastest solve', value: secs(fastest.ms), name: fastest.name, pid: fastest.pid, sub: `“${fastest.title}”` });
  }
  // Two correct is the floor for an average: one lucky guess would otherwise
  // win this outright over someone who answered every round.
  const steady = leaderboard.reduce((a, b) => {
    if (b.avgMs == null || !(b.correct > 1)) return a;
    return !a || b.avgMs < a.avgMs ? b : a;
  }, null);
  if (steady) {
    cards.push({ cap: 'Lowest average', value: secs(steady.avgMs), name: steady.name, pid: steady.pid, sub: `across ${steady.correct} solves` });
  }
  return cards;
}

function SongRow({ song, solo, me, hues, index }) {
  const [broken, setBroken] = useState(false);
  const first = song.solvers[0];
  const mine = song.solvers.some((s) => s.pid === me);
  const speedClass = first ? (first.ms < 3000 ? 'fast' : first.ms < 8000 ? 'ok' : 'slow') : 'miss';

  return (
    <li
      style={{ '--i': index }}
      className={`song${mine ? ' mine' : ''}${first ? '' : ' missed'}`}
      title={solo ? undefined : song.solvers.map((s) => `${s.place}. ${s.name} — ${secs(s.ms)}`).join('\n')}
    >
      <span className="num mono">{song.round}</span>
      <span className="cover">
        {song.artwork && !broken
          ? <img src={song.artwork} alt="" loading="lazy" onError={() => setBroken(true)} />
          : <EighthNote className="cover-glyph" />}
      </span>
      <span className="info">
        <b>{song.title}</b>
        <span>{[song.artist, song.year].filter(Boolean).join(' · ')}</span>
      </span>
      <span className="who">
        {!first ? (
          <span className="none">{solo ? 'missed' : 'nobody got it'}</span>
        ) : solo ? (
          <span className={`mono ${speedClass}`}>{secs(first.ms)}</span>
        ) : (
          <>
            <span className="first-solver" style={{ color: hues(first.pid) }}>
              {first.pid === me ? 'you' : first.name} <span className="mono">{secs(first.ms)}</span>
            </span>
            <span className="count">{song.solvers.length}/{song.eligible} got it</span>
          </>
        )}
      </span>
    </li>
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
      className="btn btn-xl tone-cream grow"
      onClick={async () => setLabel((await copyText(shareText(day, result))) ? 'Copied!' : "Couldn't copy — try again")}
    >
      <ShareIcon width="20" height="20" />
      {label}
    </button>
  );
}
