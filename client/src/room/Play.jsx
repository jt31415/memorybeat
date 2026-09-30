import VizView from './VizView.jsx';
import { Avatar } from '../components/common.jsx';
import { CHOICE_MARKS, CheckIcon } from '../components/glyphs.jsx';

/*
 * The round screen: the blanks (or the answer), the meter, a status line, and
 * whichever way this round is answered -- four cards, or a guess box.
 */
export default function Play({ session, guessRef, barred, guessText, setGuessText }) {
  const { round, room, me, clock, caption, status, hues, actions, attachViz, guessLive } = session;
  const solo = !!(room && room.solo);
  const choosing = !!(round && round.mode === 'choice');
  const reveal = round && round.reveal;
  const answeredNow = (room ? room.players : []).filter((p) => p.answered);

  return (
    <div className={`play${choosing ? ' choosing' : ''}${barred && !choosing ? ' barred' : ''}${solo ? ' solo' : ''}`}>
      {/* The artist hint lands in the same spot in both modes. Multiple choice
          has no blanks under it -- the answer is on a card. */}
      <div className="answer">
        {reveal ? (
          <div className="answer-reveal">
            <h1>{reveal.track.title}</h1>
            <p>{reveal.track.artist}</p>
          </div>
        ) : (
          <>
            <div className={`artist-hint${round && round.artist ? ' on' : ''}`} aria-live="polite">
              {round && round.artist && (
                <><span className="artist-hint-label">Artist</span><b>{round.artist}</b></>
              )}
            </div>
            {!choosing && <Mask mask={round ? round.mask : ''} solved={!!(round && round.solved)} />}
          </>
        )}
      </div>

      <VizView
        attach={attachViz}
        timer={clock.timer}
        glyph={clock.glyph}
        urgent={clock.urgent}
        caption={caption}
        artwork={reveal ? reveal.track.artwork : null}
        revealed={!!reveal}
      />

      <div className="status-line" role="status" aria-live="polite">
        {!solo && !reveal && answeredNow.length > 0 && (
          <span className="stack" aria-hidden="true">
            {answeredNow.slice(0, 6).map((p) => <Avatar key={p.pid} name={p.name} color={hues(p.pid)} size={22} label={false} />)}
          </span>
        )}
        {status.text && <span className={status.tone}>{status.text}</span>}
      </div>

      {choosing && round.choices && (
        // Keyed by round so a new set of cards never inherits the last
        // round's right-and-wrong styling mid-transition.
        <Choices key={round.index} round={round} me={me} hues={hues} onPick={actions.choose} />
      )}

      {barred && !choosing && (
        <GuessBar
          inputRef={guessRef}
          session={session}
          text={guessText}
          setText={setGuessText}
        />
      )}

      {/* Solo only: nobody else is on the clock, so a song you don't know can be
          given up on instead of waited out. The row keeps its space for the
          whole round; only the button comes and goes. */}
      {solo && (
        <div className="skip-row">
          <button
            type="button"
            className={`btn-quiet${canSkip(round, guessLive) ? ' on' : ''}`}
            disabled={!canSkip(round, guessLive)}
            onClick={actions.skip}
          >
            Skip song
          </button>
        </div>
      )}
    </div>
  );
}

function canSkip(round, live) {
  if (!round || !live || round.spectating) return false;
  return !(round.solved || round.picked != null || round.skipped || round.wrong);
}

/**
 * The blanked-out title, one tile per character, grouped into words so a wrap
 * never splits one down the middle.
 */
function Mask({ mask, solved }) {
  const words = String(mask || '').split(' ').filter(Boolean);
  let n = 0;
  return (
    <div className={`mask${solved ? ' solved' : ''}`} aria-label={solved ? `Song title: ${mask}` : 'Song title, hidden'}>
      {words.map((word, w) => (
        <span className="mask-word" key={w}>
          {[...word].map((ch, i) => {
            // A letter turning over animates wherever it is. When the whole
            // title fills in at once it runs as a wave, left to right; a hint
            // is a single letter and flips straight away.
            const index = n++;
            return (
              <span
                key={i}
                className={`tile${ch === '_' ? '' : ' shown'}`}
                style={solved ? { '--i': index } : undefined}
              >
                {ch === '_' ? '' : ch}
              </span>
            );
          })}
        </span>
      ))}
    </div>
  );
}

/**
 * The four songs. Titles only -- the artist stays a mid-round hint exactly as
 * it is in a typing round.
 *
 * Buttons start disabled: they only mean anything once the clip is playing, and
 * a card pressed during the countdown would be an answer given before the
 * question. At the reveal each card shows who picked it.
 */
function Choices({ round, me, hues, onPick }) {
  const reveal = round.reveal;
  const open = round.phase === 'playing' && round.picked == null && !round.spectating && !round.solved && !round.wrong;
  const results = reveal ? reveal.results : [];

  return (
    <div className={`choices${reveal ? ' revealed' : ''}${!open ? ' locked' : ''}`} role="group" aria-label="Pick the song">
      {round.choices.map((card, i) => {
        const { Glyph, name, tone } = CHOICE_MARKS[i % CHOICE_MARKS.length];
        const right = round.correctIndex === i || (round.solved && !reveal && round.picked === i);
        const mine = round.picked === i;
        const state = reveal
          ? (right ? 'right' : mine ? 'wrong' : 'dim')
          : (mine ? (round.wrong ? 'wrong' : round.solved ? 'right' : 'picked') : (round.picked != null ? 'dim' : ''));
        const pickers = results.filter((x) => x.pick === i);
        return (
          <button
            key={i}
            type="button"
            className={`choice tone-${tone} ${state}`}
            disabled={!open}
            onClick={() => onPick(i)}
            aria-label={`${i + 1}: ${card.title} (${name})`}
          >
            <Glyph className="choice-mark" />
            <span className="choice-text">
              <span className="choice-title">{card.title}</span>
              {reveal && card.artist && <span className="choice-artist">{card.artist}</span>}
            </span>
            {mine && state === 'wrong' && <span className="choice-tag">Your pick</span>}
            {pickers.length > 0 && (
              <span className="stack" aria-label={`Picked by ${pickers.map((p) => (p.pid === me ? 'you' : p.name)).join(', ')}`}>
                {pickers.slice(0, 6).map((p) => <Avatar key={p.pid} name={p.name} color={hues(p.pid)} size={24} label={false} />)}
              </span>
            )}
            {state === 'right' && <span className="choice-check"><CheckIcon width="18" height="18" /></span>}
            <kbd className="choice-key" aria-hidden="true">{i + 1}</kbd>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The pinned answer box. Solo gets it because there is no sidebar to type into;
 * a phone gets it because the chat box is a screen and a half below the stage.
 * On a phone it carries ordinary chat outside a live round rather than sitting
 * there dead. Solo has nobody to talk to, so there it is a guess box or nothing.
 */
function GuessBar({ inputRef, session, text, setText }) {
  const { room, round, guessLive, actions } = session;
  const solo = !!(room && room.solo);
  const revealed = !!(round && round.reveal);
  // The reveal fills the title in for everyone; that is not the same as
  // having got it.
  const solved = !!(round && round.solved) && !revealed;
  const guessing = guessLive && !solved;
  const asChat = !solo && !guessing;

  const placeholder = guessing
    ? 'Type your guess…'
    : revealed
      ? (solo ? 'Next song coming up…' : 'Say something…')
      : solved
        ? (solo ? 'You got it!' : 'Chat with the others who got it…')
        : asChat ? 'Say something…' : 'Type your guess…';

  return (
    <form
      className="guess-bar"
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
        maxLength={80}
        aria-label={guessing ? 'Your guess' : 'Message'}
        placeholder={placeholder}
        disabled={!guessing && !asChat}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className="btn tone-tangerine" disabled={!guessing && !asChat}>
        {guessing || solo ? 'Guess' : 'Send'}
      </button>
    </form>
  );
}
