'use strict';

const crypto = require('crypto');
const daily = require('./daily');
const { selectPacks, trackKey, dedupeKey } = require('./packs');
const { resolveMany, mintToken, prefetch } = require('./itunes');
const { judge, maskTitle, revealableIndexes, norm } = require('./guess');
const {
  DEFAULT_DIFFICULTY,
  clampDifficulty,
  describe: describeDifficulty,
  weightedOrder,
  uniformOrder
} = require('./difficulty');

const ROUND_MS = 30000;      // time players have to type a guess
const REVEAL_MS = 7000;      // answer + scoreboard screen
const COUNTDOWN_MS = 3000;   // 3..2..1 before audio starts
const LOAD_WAIT_MS = 12000;  // longest we wait for slow clients to buffer
const LOAD_DEADLINE_MS = 15000; // longest we spend resolving songs before a game
const EMPTY_ROOM_MS = 120000;
const DEFAULT_ROUNDS = 10;
// How many recently played songs a room avoids repeating. Independent shuffles
// repeat far more than people expect -- drawing 10 from 120 gives two clean
// games in a row only ~41% of the time -- so recent picks are held back.
const HISTORY_MAX = 40;
const MAX_POINTS = 1000;
// Fractions of the round at which hints land: the artist first, then letters.
const HINT_AT = [0.4, 0.62, 0.82];

// How a round is answered. 'classic' is the typed guess; 'choice' puts four
// songs on screen -- the answer plus three decoys drawn from the same packs.
const MODES = ['classic', 'choice'];
const DEFAULT_MODE = 'classic';
const CHOICE_COUNT = 4;
// Decoys are drawn from the answer's own neighbourhood in the pack, which is
// ordered by popularity -- pairing a chart-topper with three songs nobody has
// heard of makes the answer obvious without the audio.
const DECOY_SPAN = 80;

// Letters only -- codes get read out loud and typed from memory, and a mixed
// alphabet makes that harder than it needs to be. I and O are still out, since
// they are the two letters people hear (and type) as digits.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const rooms = new Map();

function makeCode() {
  let code;
  do {
    code = Array.from(
      { length: 4 },
      () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

function cleanMode(mode) {
  const want = String(mode || '').toLowerCase();
  return MODES.includes(want) ? want : DEFAULT_MODE;
}

function cleanName(name) {
  const trimmed = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return trimmed || 'Player';
}

class Room {
  constructor(io, opts) {
    this.io = io;
    this.code = makeCode();
    this.solo = !!opts.solo;
    // One or more packs, played as one merged list. `pack` is a selection (see
    // packs.js) -- pack-shaped, so everything below reads it the same either way.
    this.pack = selectPacks(opts.packIds);
    this.packIds = this.pack ? this.pack.ids : [];
    this.password = opts.password || '';
    this.maxPlayers = this.solo ? 1 : Math.min(Math.max(Number(opts.maxPlayers) || 8, 2), 20);
    // configuredRounds is what the host asked for; totalRounds is what the
    // current game actually managed to load (never more, sometimes fewer).
    this.configuredRounds = Math.min(Math.max(Number(opts.rounds) || DEFAULT_ROUNDS, 3), 20);
    this.totalRounds = this.configuredRounds;
    // Which end of the pack songs are drawn from. 0 = the hits everyone knows,
    // 100 = the long tail. See difficulty.js -- it is a weighting, not a filter.
    this.difficulty = opts.difficulty == null
      ? DEFAULT_DIFFICULTY
      : clampDifficulty(opts.difficulty);
    // How players answer: type the title, or pick it out of four. See MODES.
    this.mode = cleanMode(opts.mode);
    this.hostPid = opts.hostPid;
    /**
     * Daily challenge rooms: `{ day, user }`, or null for an ordinary room.
     *
     * A daily is a solo game with every one of its settings taken away -- the
     * songs, the mode, the difficulty and the round count are all the same for
     * everybody that day, which is the only reason the leaderboard means
     * anything. So `daily` is read all over this class as "this room does not
     * get to choose", and the setters below refuse outright rather than
     * accepting a change the leaderboard would then be lying about.
     */
    this.daily = opts.daily || null;
    /**
     * A song list decided elsewhere, played exactly as given.
     *
     * The daily hands its five frozen tracks in here rather than letting
     * start() draw from the pack, because "the same five songs for everyone" is
     * settled a level up (see daily.js) and must not be re-rolled per room.
     */
    this.fixedTracks = Array.isArray(opts.fixedTracks) && opts.fixedTracks.length
      ? opts.fixedTracks.slice()
      : null;
    // dedupeKey -> position in this.pack.tracks, built on demand and thrown
    // away with the pack. Only multiple choice needs it (see pickDecoys).
    this.packPositions = null;

    this.players = new Map(); // pid -> player
    this.state = 'lobby';     // lobby | loading | countdown | playing | reveal | ended
    this.tracks = [];
    this.roundIndex = -1;
    this.round = null;
    // One entry per round of the current game, filled in at each reveal and read
    // by the final scores screen. See recordRound / buildSummary.
    this.recap = [];
    // The last game:over payload, kept so somebody who reloads on the final
    // screen gets the songs back instead of an empty list.
    this.summary = null;
    this.timers = new Set();
    // trackKeys played in this room's recent games, oldest first.
    this.history = [];
    // True once start() has been through once. Only the daily reads it, and
    // only to make sure a run cannot be taken twice.
    this.started = false;
    this.createdAt = Date.now();
    // Counts as empty until the creator actually lands on the room page, so a
    // room created and then abandoned gets reaped instead of lingering.
    this.emptySince = this.createdAt;

    rooms.set(this.code, this);
  }

  /* ------------------------------------------------------------- players */

  addPlayer({ pid, name, socketId }) {
    const existing = this.players.get(pid);
    if (existing) {
      existing.socketId = socketId;
      existing.connected = true;
      if (name) existing.name = cleanName(name);
      this.emptySince = null;
      this.seatMidRound(existing);
      return existing;
    }
    const player = {
      pid,
      name: cleanName(name),
      socketId,
      score: 0,
      connected: true,
      solved: false,
      // Round index this player has to sit out, if any. See seatMidRound.
      spectating: null,
      joinedAt: Date.now()
    };
    this.players.set(pid, player);
    this.emptySince = null;
    this.seatMidRound(player);
    return player;
  }

  /**
   * Anyone arriving once the clip is already playing has no audio for it, so
   * they sit the round out. Marking that explicitly matters: otherwise the
   * round's ready and all-solved checks wait on a player who cannot act.
   *
   * Arriving during the countdown is fine -- nothing has started yet, so they
   * get a token and play the round like everybody else.
   */
  seatMidRound(player) {
    if (this.round && this.state === 'playing') player.spectating = this.roundIndex;
  }

  /** Active players who can actually play the current round. */
  contenders() {
    return this.activePlayers().filter((p) => p.spectating !== this.roundIndex);
  }

  /**
   * If the creator never showed up, don't leave everyone else stranded without
   * a start button -- hand the room to whoever is actually here.
   */
  ensureHost() {
    const hostHere = [...this.players.values()].some((p) => p.pid === this.hostPid && p.connected);
    if (hostHere || Date.now() - this.createdAt < 30000) return;
    const heir = this.activePlayers()[0];
    if (heir) this.hostPid = heir.pid;
  }

  removePlayer(pid) {
    const player = this.players.get(pid);
    if (!player) return;
    if (this.state === 'lobby' || this.state === 'ended') {
      this.players.delete(pid);
    } else {
      player.connected = false; // keep the score around for a reconnect
      player.socketId = null;
    }
    if (pid === this.hostPid) {
      const heir = [...this.players.values()].find((p) => p.connected);
      if (heir) {
        this.hostPid = heir.pid;
        this.system('host', `${heir.name} is now the host.`, {
          pid: heir.pid,
          name: heir.name
        });
      }
    }
    if (![...this.players.values()].some((p) => p.connected)) {
      this.emptySince = Date.now();
    }
  }

  activePlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  isFull() {
    return this.activePlayers().length >= this.maxPlayers;
  }

  /* -------------------------------------------------------------- emitting */

  publicState() {
    return {
      code: this.code,
      solo: this.solo,
      packIds: this.packIds,
      packName: this.pack ? this.pack.name : 'Unknown pack',
      packCount: this.pack ? this.pack.tracks.length : 0,
      maxPlayers: this.maxPlayers,
      hasPassword: !!this.password,
      totalRounds: this.totalRounds,
      difficulty: this.difficulty,
      difficultyLabel: describeDifficulty(this.difficulty).name,
      // True when the room plays an imported playlist: every song equally
      // likely, so the client hides the difficulty slider rather than showing a
      // control that does nothing. See packs.registerImport.
      equalWeight: !!(this.pack && this.pack.equalWeight),
      playlist: this.pack && this.pack.imported
        ? { source: this.pack.source, url: this.pack.url, name: this.pack.name }
        : null,
      mode: this.mode,
      // The client hides every lobby control for a daily room -- there is
      // nothing in there it is allowed to change.
      daily: this.daily ? { day: this.daily.day } : null,
      state: this.state,
      hostPid: this.hostPid,
      roundIndex: this.roundIndex,
      players: [...this.players.values()]
        .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt)
        .map((p) => ({
          pid: p.pid,
          name: p.name,
          score: p.score,
          connected: p.connected,
          isHost: p.pid === this.hostPid,
          answered: !!(this.round && this.round.answers.has(p.pid))
        }))
    };
  }

  broadcast(event, payload) {
    this.io.to(this.code).emit(event, payload);
  }

  toPlayer(pid, event, payload) {
    const player = this.players.get(pid);
    if (player && player.socketId) this.io.to(player.socketId).emit(event, payload);
  }

  syncState() {
    this.broadcast('room:state', this.publicState());
  }

  /**
   * System lines carry a `kind` and their structured pieces, not just a
   * sentence. The client leans on that to separate housekeeping (joins,
   * leaves) from the two lines players actually scan for -- who solved it and
   * what the song was -- and to tint a name in that player's own colour.
   * `text` stays as the plain-language fallback.
   */
  system(kind, text, extra) {
    this.broadcast('chat:message', {
      system: true,
      kind,
      text,
      at: Date.now(),
      ...(extra || {})
    });
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      try {
        fn();
      } catch (err) {
        console.error(`[room ${this.code}]`, err);
      }
    }, ms);
    this.timers.add(t);
    return t;
  }

  clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /* ----------------------------------------------------------------- chat */

  /**
   * Everything typed into the chat box during a round is a guess first and a
   * message second -- skribbl rules. A correct guess is swallowed so it can
   * never appear in the log; anything else is just chat.
   */
  chat(pid, text) {
    const player = this.players.get(pid);
    if (!player) return;
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!clean) return;

    // The chat box is a scoring input now, so hold the floodgate shut.
    const now = Date.now();
    if (player.lastChatAt && now - player.lastChatAt < 250) return;
    player.lastChatAt = now;

    const live = this.state === 'playing' && this.round;

    // Picking rounds are answered with a card, so the chat box is only a chat
    // box -- but typing the title into it would hand it to everybody, so a
    // correct one is swallowed the same way it is in a typing round.
    if (live && this.mode === 'choice') {
      if (judge(clean, this.round.track) === 'correct') {
        this.toPlayer(pid, 'chat:nudge', { text: 'No spoilers — pick the card.' });
        return;
      }
      return this.say(player, clean, false);
    }

    // Already solved: talk freely, but only to the others who got it.
    if (live && player.solved) return this.say(player, clean, true);
    if (!live) return this.say(player, clean, false);

    const verdict = judge(clean, this.round.track);

    // Sitting this round out: no points for a round they had no audio for, and
    // a correct title must not go out over chat and spoil it for the others.
    if (player.spectating === this.roundIndex) {
      if (verdict === 'correct') {
        this.toPlayer(pid, 'chat:nudge', { text: "That's it -- but you're sitting this round out." });
        return;
      }
      return this.say(player, clean, false);
    }

    if (verdict === 'correct') {
      this.award(player, clean);
      return;
    }

    // Wrong guesses are public -- watching everyone flail is half the fun.
    this.say(player, clean, false);
    if (verdict === 'close') {
      this.toPlayer(pid, 'chat:nudge', { text: `"${clean}" is close!` });
    } else if (verdict === 'artist') {
      this.toPlayer(pid, 'chat:nudge', { text: "That's the artist — now name the song." });
    }
  }

  /** Deliver an ordinary chat line, to everyone or to fellow solvers only. */
  say(player, text, solversOnly) {
    const message = {
      pid: player.pid,
      name: player.name,
      text,
      at: Date.now(),
      private: !!solversOnly
    };
    if (!solversOnly) return this.broadcast('chat:message', message);
    for (const other of this.players.values()) {
      if (other.connected && other.solved) this.toPlayer(other.pid, 'chat:message', message);
    }
  }

  /** Score a correct guess and tell the room without naming the song. */
  award(player, guessText) {
    const elapsed = Math.max(0, Date.now() - this.round.startAt);
    const points = Math.max(
      1,
      Math.round(MAX_POINTS * (1 - Math.min(elapsed / ROUND_MS, 1) / 2))
    );

    player.solved = true;
    player.score += points;
    this.round.answers.set(player.pid, { correct: true, points, elapsed, guess: guessText });

    // Only the solver gets the title -- they already know it, and seeing it
    // spelled out is the payoff for getting there first.
    this.toPlayer(player.pid, 'round:answered', {
      correct: true,
      points,
      score: player.score,
      elapsed,
      place: this.round.answers.size,
      title: this.round.track.title,
      artist: this.round.track.artist
    });
    this.system('solve', `${player.name} guessed it in ${(elapsed / 1000).toFixed(1)}s!`, {
      pid: player.pid,
      name: player.name,
      seconds: Number((elapsed / 1000).toFixed(1)),
      place: this.round.answers.size,
      points
    });
    this.broadcast('round:progress', {
      pid: player.pid,
      name: player.name,
      answered: this.round.answers.size,
      of: this.contenders().length
    });

    // Typing rounds run until everyone has it right; picking rounds are over
    // as soon as everyone has committed, right or wrong.
    if (this.mode === 'choice') return this.endIfEveryoneAnswered();
    const active = this.contenders();
    if (active.length && active.every((p) => p.solved)) {
      this.clearTimers();
      this.later(() => this.endRound(), 900);
    }
  }

  /* -------------------------------------------------------------- settings */

  /**
   * Host changing which packs the room plays, from the lobby, between games.
   *
   * The client sends the whole selection rather than a pack to toggle, so a
   * click that crosses with a state sync cannot leave the two disagreeing about
   * what is on. An empty or all-unknown selection is refused outright -- a room
   * with nothing to draw from has no start button worth pressing.
   */
  setPacks(pid, packIds) {
    if (this.daily) return;
    if (pid !== this.hostPid) return;
    if (this.state !== 'lobby' && this.state !== 'ended') return;
    const selection = selectPacks(packIds);
    if (!selection || (this.pack && selection.key === this.pack.key)) return;

    this.pack = selection;
    this.packIds = selection.ids;
    this.packPositions = null;
    // History is keyed by song rather than by pack, and historyLimit is sized
    // against the list we are about to draw from -- carrying 40 held-back songs
    // into a smaller selection could starve it. New selection, clean slate.
    this.history = [];
    // A previous game that came up short must not shrink this one.
    this.totalRounds = this.configuredRounds;
    const label = selection.imported
      ? 'Playlist is'
      : (selection.ids.length > 1 ? 'Song packs are' : 'Song pack is');
    this.system('pack', `${label} now ${selection.name}.`, { packName: selection.name });
    this.syncState();
  }

  /**
   * Host sliding the difficulty in the lobby. Unlike a pack switch this leaves
   * the history alone: it changes which songs are *preferred*, not which pack
   * they come from, so recently played ones are just as worth holding back.
   */
  setDifficulty(pid, value) {
    if (this.daily) return;
    if (pid !== this.hostPid) return;
    if (this.state !== 'lobby' && this.state !== 'ended') return;
    // An imported playlist is evenly weighted by definition, so there is nothing
    // for this to change. Refused rather than stored, so the state the client
    // paints can never imply a setting that is not being applied.
    if (this.pack && this.pack.equalWeight) return;
    const next = clampDifficulty(value);
    if (next === this.difficulty) return;

    const before = describeDifficulty(this.difficulty).name;
    this.difficulty = next;
    const level = describeDifficulty(next);
    // Only announce a move that crosses into a different band -- the slider is
    // continuous and a nudge from 40 to 45 is not worth a line of chat.
    if (level.name !== before) {
      this.system('difficulty', `Difficulty is now ${level.name} — ${level.blurb}.`, {
        difficulty: next,
        difficultyLabel: level.name
      });
    }
    this.syncState();
  }

  /**
   * Host switching between typing the answer and picking it out of four.
   * Lobby-only, like the other settings: the two modes have different round
   * payloads, and swapping mid-round would leave half the room with a guess box
   * and the other half with buttons.
   */
  setMode(pid, mode) {
    if (this.daily) return;
    if (pid !== this.hostPid) return;
    if (this.state !== 'lobby' && this.state !== 'ended') return;
    const next = cleanMode(mode);
    if (next === this.mode) return;

    this.mode = next;
    this.system('mode', next === 'choice'
      ? 'Answer mode is now multiple choice.'
      : 'Answer mode is now typing.', { mode: next });
    this.syncState();
  }

  /* ----------------------------------------------------------- song choice */

  /**
   * How much history this pack can afford to hold back. Remembering more songs
   * than the pack can spare would starve the next game, so the limit always
   * leaves a couple of rounds' worth of unheard tracks to draw from.
   */
  historyLimit() {
    const packSize = this.pack ? this.pack.tracks.length : 0;
    return Math.max(0, Math.min(HISTORY_MAX, packSize - this.configuredRounds * 2));
  }

  /**
   * The pack shuffled, with recently played songs moved to the back.
   *
   * The shuffle is weighted by the room's difficulty, so the songs it wants
   * come out near the front -- but it is still a shuffle of the *whole* pack,
   * and every track keeps a real chance of turning up (see difficulty.js).
   */
  orderCandidates() {
    const recent = new Set(this.history);
    // An imported playlist is a flat pool -- every song equally likely -- so it
    // gets a plain shuffle. Reaching for weightedOrder() here would not be
    // neutral, it would rank by playlist position; see difficulty.uniformOrder.
    const shuffled = this.pack.equalWeight
      ? uniformOrder(this.pack.tracks)
      : weightedOrder(this.pack.tracks, this.difficulty);
    if (!recent.size) return shuffled;

    const fresh = [];
    const repeats = [];
    for (const track of shuffled) {
      (recent.has(trackKey(track)) ? repeats : fresh).push(track);
    }
    return fresh.concat(repeats);
  }

  remember(tracks) {
    const limit = this.historyLimit();
    if (!limit) {
      this.history = [];
      return;
    }
    for (const track of tracks) this.history.push(trackKey(track));
    if (this.history.length > limit) {
      this.history = this.history.slice(this.history.length - limit);
    }
  }

  /* --------------------------------------------------------- the four cards */

  /** Where a song sits in the pack's popularity order, or null if it is not in
   *  the pack at all (a resolved track is a copy, so this goes by key). */
  packPosition(key) {
    if (!this.packPositions) {
      this.packPositions = new Map();
      this.pack.tracks.forEach((track, i) => {
        const k = dedupeKey(track.title, track.artist);
        if (!this.packPositions.has(k)) this.packPositions.set(k, i);
      });
    }
    const at = this.packPositions.get(key);
    return at == null ? null : at;
  }

  /**
   * Wrong answers to sit alongside the right one.
   *
   * Drawn from the slice of the pack around the answer rather than from the
   * whole thing: the pack is ordered by popularity, so a window keeps all four
   * cards about equally famous. Line a household name up against three
   * obscurities and the answer is readable off the shape of the list alone.
   */
  pickDecoys(track, n) {
    const pool = this.pack.tracks;
    const answerKey = dedupeKey(track.title, track.artist);
    const at = this.packPosition(answerKey);

    // A window only makes sense with enough songs on both sides of it to still
    // offer a choice; a small pack just uses everything it has.
    const room = (n + 1) * 4;
    let lo = 0;
    let hi = pool.length;
    if (at != null && pool.length > room) {
      lo = Math.max(0, at - DECOY_SPAN);
      hi = Math.min(pool.length, Math.max(lo + room, at + DECOY_SPAN + 1));
      lo = Math.min(lo, hi - room);
    }

    const seen = new Set([answerKey]);
    // The cards carry the title alone, so two songs that merely share one --
    // "Hero" by Mariah Carey and "Hero" by Enrique Iglesias are both in here --
    // would print as the same card twice, with no way to tell which is right.
    const titles = new Set([norm(track.title)]);
    const out = [];
    // Sampling with rejection: cheap, and the guard means a window that is
    // mostly duplicates ends the round with fewer cards rather than spinning.
    for (let tries = 0; out.length < n && tries < 300; tries++) {
      const candidate = pool[lo + crypto.randomInt(hi - lo)];
      const key = dedupeKey(candidate.title, candidate.artist);
      const title = norm(candidate.title);
      if (seen.has(key) || titles.has(title)) continue;
      seen.add(key);
      titles.add(title);
      out.push({ title: candidate.title, artist: candidate.artist });
    }
    return out;
  }

  /** The answer plus its decoys, shuffled. Returns null outside choice mode. */
  buildChoices(track) {
    if (this.mode !== 'choice') return null;
    const cards = [
      { title: track.title, artist: track.artist, answer: true },
      ...this.pickDecoys(track, CHOICE_COUNT - 1)
    ];
    for (let i = cards.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    // Titles only, and deliberately so: the artist is a mid-round hint in this
    // mode too, and shipping it on the cards would put the answer's artist in
    // the network tab before the hint ever lands.
    return {
      cards: cards.map(({ title }) => ({ title })),
      correct: cards.findIndex((c) => c.answer)
    };
  }

  /** Score a picked card. Right or wrong, that is the player's answer. */
  submitChoice(pid, index) {
    if (this.mode !== 'choice') return;
    if (!this.round || this.state !== 'playing' || !this.round.choices) return;

    const player = this.players.get(pid);
    if (!player || !player.connected) return;
    if (player.spectating === this.roundIndex) return;
    if (this.round.answers.has(pid)) return; // one shot

    const pick = Number(index);
    const cards = this.round.choices.cards;
    if (!Number.isInteger(pick) || pick < 0 || pick >= cards.length) return;

    const correct = pick === this.round.choices.correct;
    if (correct) {
      this.award(player, cards[pick].title);
      return;
    }

    // A wrong card is final -- otherwise picking all four in order always wins.
    this.round.answers.set(pid, { correct: false, points: 0, pick });
    this.toPlayer(pid, 'round:answered', {
      correct: false,
      points: 0,
      score: player.score,
      pick,
      correctIndex: null // held back until the reveal
    });
    this.broadcast('round:progress', {
      pid: player.pid,
      name: player.name,
      answered: this.round.answers.size,
      of: this.contenders().length
    });
    this.endIfEveryoneAnswered();
  }

  /**
   * Give up on the current round. Single player only: with nobody else waiting
   * on the clock, a song you plainly do not know is better abandoned than sat
   * out for the full thirty seconds.
   *
   * No answer is recorded, so it counts as a miss -- the reveal names the song
   * and the game moves on exactly as it would have when the timer ran out.
   */
  skip(pid) {
    if (!this.solo) return;
    if (this.state !== 'playing' || !this.round) return;
    const player = this.players.get(pid);
    if (!player || !player.connected || player.solved) return;
    if (player.spectating === this.roundIndex) return;
    this.endRound();
  }

  /** In choice mode a round is over once nobody is left to pick. */
  endIfEveryoneAnswered() {
    const active = this.contenders();
    if (active.length && active.every((p) => this.round.answers.has(p.pid))) {
      this.clearTimers();
      this.later(() => this.endRound(), 900);
    }
  }

  /* ------------------------------------------------------------ game flow */

  async start(pid) {
    if (pid !== this.hostPid) return;
    if (this.state !== 'lobby' && this.state !== 'ended') return;
    // A daily is one run, and the run began the first time this was called.
    // Replaying the room would be a second attempt at songs the player has now
    // heard, so the only way back to the start is a fresh room -- which
    // /api/daily/start refuses once a run has been finished and filed.
    if (this.daily && this.started) return;
    if (!this.pack) {
      this.broadcast('room:error', { message: 'That song pack no longer exists.' });
      return;
    }

    this.clearTimers();
    this.started = true;
    this.state = 'loading';
    this.recap = [];
    this.summary = null;
    for (const player of this.players.values()) {
      player.score = 0;
      player.solved = false;
    }
    this.syncState();
    this.broadcast('game:loading', { message: 'Loading songs...' });

    // Offer the whole pack in random order and stop as soon as we have enough
    // playable tracks -- cached ones cost nothing, so a warm cache starts
    // instantly and a cold one still starts within the deadline.
    //
    // Recently played songs go to the back rather than being dropped: the
    // resolver takes the first N it can play, so they are only reached when the
    // fresh ones run out (small pack, or a cold cache). Better a repeat than a
    // short game.
    // A fixed list is already resolved and already in the right order, so there
    // is nothing to choose and nothing to look up -- see this.fixedTracks.
    if (this.fixedTracks) return this.startWith(this.fixedTracks);

    const candidates = this.orderCandidates();

    let resolved;
    try {
      resolved = await resolveMany(candidates, {
        enough: this.configuredRounds,
        deadlineMs: LOAD_DEADLINE_MS,
        // Recent songs must not satisfy the quota, or a barely-warm cache would
        // keep serving the same few songs instead of resolving new ones.
        avoid: new Set(this.history)
      });
    } catch (err) {
      console.error('[game] resolve failed', err);
      resolved = [];
    }

    if (resolved.length < 3) {
      this.state = 'lobby';
      this.syncState();
      this.broadcast('room:error', {
        message: 'Could not load songs right now. Check the server\'s internet connection and try again.'
      });
      return;
    }

    this.startWith(resolved.slice(0, this.configuredRounds));
  }

  /** Take a settled song list and get the first round moving. */
  startWith(tracks) {
    this.tracks = tracks;
    this.remember(this.tracks);
    this.totalRounds = this.tracks.length;
    this.roundIndex = -1;
    prefetch(this.tracks.map((t) => t.previewUrl));

    this.state = 'countdown';
    this.syncState();
    this.nextRound();
  }

  nextRound() {
    this.roundIndex += 1;
    if (this.roundIndex >= this.tracks.length) return this.finish();

    const track = this.tracks[this.roundIndex];

    this.round = {
      track,
      answers: new Map(),
      ready: new Set(),
      startAt: null,
      revealed: new Set(),          // title character indexes given away as hints
      artistShown: false,
      // { cards, correct } in choice mode, null when players type their answer.
      choices: this.buildChoices(track)
    };
    // A new round clears the slate: anyone who sat the last one out is a full
    // player again, from the countdown onwards.
    for (const player of this.players.values()) {
      player.solved = false;
      player.spectating = null;
    }

    this.state = 'countdown';
    this.syncState();
    this.broadcast('round:prepare', this.preparePayload({ token: true }));

    this.readyDeadline = this.later(() => this.beginRound(), LOAD_WAIT_MS);
  }

  /**
   * What a client needs to set the current round up: the same shape whether it
   * arrives with the round or is pushed to somebody who turned up late.
   *
   * In choice mode there is no mask -- the answer is already one of the four
   * cards, and blanks would just narrow it to one. The artist hint still lands.
   */
  preparePayload({ token = false, rejoin = false } = {}) {
    return {
      index: this.roundIndex,
      total: this.totalRounds,
      mode: this.mode,
      mask: this.currentMask(),
      artist: this.round.artistShown ? this.round.track.artist : null,
      choices: this.round.choices ? this.round.choices.cards : null,
      token: token ? mintToken(this.round.track.previewUrl) : null,
      timeLimit: ROUND_MS,
      rejoin
    };
  }

  markReady(pid) {
    if (!this.round || this.state !== 'countdown') return;
    this.round.ready.add(pid);
    const active = this.contenders();
    if (active.length && active.every((p) => this.round.ready.has(p.pid))) {
      this.clearTimers();
      this.later(() => this.beginRound(), 250);
    }
  }

  beginRound() {
    if (!this.round || this.state !== 'countdown') return;
    this.clearTimers();
    this.broadcast('round:countdown', { in: COUNTDOWN_MS });
    this.later(() => {
      if (!this.round) return;
      this.state = 'playing';
      this.round.startAt = Date.now();
      this.syncState();
      this.broadcast('round:start', { timeLimit: ROUND_MS, at: this.round.startAt });
      HINT_AT.forEach((fraction, i) => {
        this.later(() => this.giveHint(i === 0), Math.round(ROUND_MS * fraction));
      });
      this.later(() => this.endRound(), ROUND_MS);
    }, COUNTDOWN_MS);
  }

  /**
   * The title mask as it stands right now, hints included -- or null in
   * multiple choice, which shows no blanks. The letter count alone would pick
   * the answer out of four, so it must not even reach the client.
   */
  currentMask() {
    if (!this.round || this.mode === 'choice') return null;
    return maskTitle(this.round.track.title, this.round.revealed);
  }

  /**
   * Drip-feed help: first the artist, then individual letters of the title.
   * Everyone sees the same hints, so nobody gets an edge from them.
   */
  giveHint(artistFirst) {
    if (!this.round || this.state !== 'playing') return;
    const { track } = this.round;

    if (artistFirst && !this.round.artistShown) {
      this.round.artistShown = true;
      this.broadcast('round:hint', { artist: track.artist, mask: this.currentMask() });
      return;
    }

    // Multiple choice takes the artist and stops there: the letter hints spell
    // out a title that is already on screen, which would end the round.
    if (this.mode === 'choice') return;

    const candidates = revealableIndexes(track.title).filter((i) => !this.round.revealed.has(i));
    // Never blank out the whole title -- keep at least a third hidden.
    const floor = Math.ceil(revealableIndexes(track.title).length / 3);
    if (candidates.length <= floor) return;

    this.round.revealed.add(candidates[crypto.randomInt(candidates.length)]);
    this.broadcast('round:hint', {
      artist: this.round.artistShown ? track.artist : null,
      mask: this.currentMask()
    });
  }

  endRound() {
    if (!this.round || (this.state !== 'playing' && this.state !== 'countdown')) return;
    this.clearTimers();
    this.state = 'reveal';

    const { track, answers } = this.round;
    const results = [...this.players.values()]
      .map((p) => {
        const a = answers.get(p.pid);
        return {
          pid: p.pid,
          name: p.name,
          score: p.score,
          correct: !!(a && a.correct),
          points: a ? a.points : 0,
          answered: !!a
        };
      })
      .sort((a, b) => b.score - a.score);

    this.recordRound(results);

    this.broadcast('round:reveal', {
      track: { title: track.title, artist: track.artist, artwork: track.artwork || null },
      correctIndex: this.round.choices ? this.round.choices.correct : null,
      results,
      last: this.roundIndex + 1 >= this.totalRounds,
      nextIn: REVEAL_MS
    });
    this.system('answer', `The song was "${track.title}" by ${track.artist}.`, {
      title: track.title,
      artist: track.artist,
      solved: results.filter((r) => r.correct).length,
      of: results.length
    });
    this.syncState();

    this.later(() => {
      this.round = null;
      if (this.roundIndex + 1 >= this.totalRounds) this.finish();
      else this.nextRound();
    }, REVEAL_MS);
  }

  /**
   * File the round that just ended away for the final screen.
   *
   * Called from the reveal, where the answer has already gone out to everyone --
   * so keeping the title here spoils nothing that is not already on screen.
   * Solvers are ordered by how long they took, which is the order the recap
   * shows them in and where `place` comes from.
   */
  recordRound(results) {
    const { track, answers } = this.round;
    const solvers = [...answers.entries()]
      .filter(([, a]) => a.correct)
      .map(([pid, a]) => ({
        pid,
        name: (this.players.get(pid) || {}).name || 'Player',
        points: a.points,
        ms: a.elapsed
      }))
      .sort((a, b) => a.ms - b.ms)
      .map((s, i) => ({ ...s, place: i + 1 }));

    this.recap.push({
      round: this.roundIndex + 1,
      title: track.title,
      artist: track.artist,
      artwork: track.artwork || null,
      // Decade packs carry the chart year; genre packs and playlists often do not.
      year: track.year || null,
      solvers,
      // Everyone who could have got it. A solver who has since disconnected is no
      // longer a contender, so the count is floored at the number who did.
      eligible: Math.max(solvers.length, this.contenders().length),
      // How many committed to an answer at all -- only meaningful in choice mode,
      // where a wrong pick is recorded; a typed miss is never an answer.
      answered: results.filter((r) => r.answered).length
    });
  }

  /**
   * Per-player totals for the final leaderboard, read off the recap.
   *
   * All of it is derivable from the rounds, so nothing has to be accumulated on
   * the player object during the game -- which also means a mid-game reconnect
   * cannot lose any of it.
   */
  playerStats(pid) {
    let correct = 0;
    let firsts = 0;
    let totalMs = 0;
    let bestMs = null;
    let streak = 0;
    let bestStreak = 0;

    for (const song of this.recap) {
      const hit = song.solvers.find((s) => s.pid === pid);
      if (!hit) {
        streak = 0;
        continue;
      }
      correct += 1;
      totalMs += hit.ms;
      if (hit.place === 1) firsts += 1;
      if (bestMs == null || hit.ms < bestMs) bestMs = hit.ms;
      streak += 1;
      if (streak > bestStreak) bestStreak = streak;
    }

    return {
      correct,
      firsts,
      bestMs,
      avgMs: correct ? Math.round(totalMs / correct) : null,
      streak: bestStreak
    };
  }

  /** The whole game, as the final screen wants it. */
  buildSummary() {
    const leaderboard = [...this.players.values()]
      .sort((a, b) => b.score - a.score)
      .map((p, i) => ({
        rank: i + 1,
        pid: p.pid,
        name: p.name,
        score: p.score,
        ...this.playerStats(p.pid)
      }));

    // The single quickest solve of the game, whoever managed it.
    let fastest = null;
    for (const song of this.recap) {
      const first = song.solvers[0];
      if (first && (!fastest || first.ms < fastest.ms)) {
        fastest = { name: first.name, pid: first.pid, ms: first.ms, title: song.title };
      }
    }

    return {
      leaderboard,
      songs: this.recap,
      totalRounds: this.totalRounds,
      solo: this.solo,
      mode: this.mode,
      packName: this.pack ? this.pack.name : 'Unknown pack',
      playlist: !!(this.pack && this.pack.imported),
      difficultyLabel: this.pack && this.pack.equalWeight
        ? null
        : describeDifficulty(this.difficulty).name,
      // Rounds where nobody landed it -- worth calling out, and cheap to count
      // here rather than in three places on the client.
      missed: this.recap.filter((s) => !s.solvers.length).length,
      fastest
    };
  }

  finish() {
    this.clearTimers();
    this.state = 'ended';
    this.round = null;
    this.summary = this.buildSummary();
    if (this.daily) this.fileDailyRun();
    this.broadcast('game:over', this.summary);
    this.syncState();
  }

  /**
   * Put a finished daily run on the leaderboard.
   *
   * Here rather than anywhere earlier because "finished" is the rule the mode
   * was built on: a run that is abandoned halfway writes nothing and can be
   * started again, which is what lets somebody who lost their connection have
   * another go. Reaching finish() is the only thing that spends the attempt.
   *
   * The score comes off the player object, which is the same number the game
   * has been broadcasting all along -- the client is never asked what it
   * scored, and could not be believed if it were.
   */
  fileDailyRun() {
    const { day, user } = this.daily;
    const player = this.players.get(this.hostPid);
    if (!player || !user) return;

    const stats = this.playerStats(player.pid);
    const totalMs = this.recap.reduce((sum, song) => {
      const hit = song.solvers.find((s) => s.pid === player.pid);
      return hit ? sum + hit.ms : sum;
    }, 0);

    let recorded = false;
    try {
      recorded = daily.recordRun(day, user, {
        score: player.score,
        correct: stats.correct,
        rounds: this.totalRounds,
        totalMs: stats.correct ? totalMs : null,
        bestMs: stats.bestMs
      });
    } catch (err) {
      // A leaderboard write failing must not eat the final screen -- the player
      // still played the game, and they should still see how they did.
      console.error('[daily] could not record run:', err.message);
    }

    // `recorded` is false when a run for this account and day already existed,
    // which normally means two tabs finished the same challenge. The client
    // says so rather than showing a score that quietly did not count.
    this.summary.daily = { day, recorded, name: user.username };
  }

  destroy() {
    this.clearTimers();
    rooms.delete(this.code);
  }
}

/* ------------------------------------------------------------------ lookup */

function createRoom(io, opts) {
  return new Room(io, opts);
}

function getRoom(code) {
  return rooms.get(String(code || '').toUpperCase()) || null;
}

// Reap rooms that everybody walked away from.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.emptySince && now - room.emptySince > EMPTY_ROOM_MS) room.destroy();
  }
}, 30000).unref();

module.exports = { createRoom, getRoom, rooms, ROUND_MS, REVEAL_MS, MODES, DEFAULT_MODE };
