import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { playerId, savedName, saveName, savedPassword, savePassword, savedVolume, saveVolume } from '../lib/storage.js';
import { assignHues, hueLookup } from '../lib/hues.js';
import { createAudioGraph } from '../lib/Visualizer.js';

/*
 * Everything a room page knows, and everything it can do.
 *
 * The server owns the game. This hook's job is to listen: every socket event
 * lands here, becomes React state, and the components paint from that state.
 * The few things that cannot be state -- the <audio> element, the visualiser's
 * canvas loop, the rAF clock -- are held in refs and driven from the same
 * handlers, so there is exactly one place where a round's lifecycle is written
 * down.
 *
 * Handlers read the latest room and round through refs rather than through
 * closures, since they are registered once for the life of the socket.
 */

const REVEAL_FADE_MS = 900; // the tail end of the reveal, not the start of it

export function useRoomSession(code) {
  const socket = useMemo(() => io({ autoConnect: false }), []);

  /* ------------------------------------------------------------ state */

  const [me, setMe] = useState(null);
  const [room, setRoom] = useState(null);
  const [round, setRoundState] = useState(null);
  const [view, setView] = useState('lobby');       // 'lobby' | 'play' | 'final'
  const [summary, setSummary] = useState(null);
  const [status, setStatusState] = useState({ text: '', tone: '' });
  const [clock, setClock] = useState({ timer: '--', urgent: false, glyph: false, label: '' });
  const [caption, setCaption] = useState('');
  const [messages, setMessages] = useState([]);
  const [chatNote, setChatNote] = useState(false);
  const [guessLive, setGuessLive] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [lobbyError, setLobbyError] = useState('');
  const [gate, setGate] = useState({
    phase: 'checking',     // 'checking' | 'open' | 'hidden'
    daily: false,
    title: `Join room ${code}`,
    sub: savedName() ? 'Everything is set — one tap lets the browser play audio.' : "Pick a name and you're in.",
    needPassword: !!savedPassword(code),
    error: '',
    busy: false
  });
  const [volume, setVolumeState] = useState(() => ({ level: savedVolume() / 100, last: savedVolume() / 100 || 0.8 }));

  // Catalogues the lobby builds its controls from.
  const [packs, setPacks] = useState(null);
  const [modes, setModes] = useState([
    { id: 'classic', label: 'Type it', blurb: 'Name the song in the chat', hint: '' },
    { id: 'choice', label: 'Multiple choice', blurb: 'Pick the song out of four', hint: '' }
  ]);
  const [diffLevels, setDiffLevels] = useState(null);

  /* ------------------------------------------------------------- refs */

  const meRef = useRef(null);
  const roomRef = useRef(null);
  const roundRef = useRef(null);
  const joinedRef = useRef(false);
  const passRef = useRef(savedPassword(code));
  const audioRef = useRef(null);
  const graphRef = useRef(null);
  const vizRef = useRef(null);
  const clockRaf = useRef(null);
  const fade = useRef({ gain: 1, token: 0 });
  const revealFade = useRef(null);
  const wantAudio = useRef(false);
  const volumeRef = useRef(volume);
  const msgId = useRef(0);

  const hues = useMemo(() => hueLookup(assignHues(room ? room.players : [])), [room]);
  const huesRef = useRef(hues);
  huesRef.current = hues;

  /** Merge into the current round, keeping the ref and the state in step. */
  const patchRound = useCallback((patch) => {
    const next = roundRef.current ? { ...roundRef.current, ...patch } : null;
    roundRef.current = next;
    setRoundState(next);
    return next;
  }, []);

  const setRound = useCallback((value) => {
    roundRef.current = value;
    setRoundState(value);
  }, []);

  const setStatus = useCallback((text, tone = '') => setStatusState({ text: text || '', tone }), []);

  /* ------------------------------------------------------------ clock */

  /*
   * One rAF loop drives the on-screen seconds, and the visualiser reads the
   * same deadline itself every frame. The text only changes on whole seconds
   * (and React skips identical updates), but it can never disagree with the arc.
   */
  const stopClock = useCallback(() => {
    if (clockRaf.current) cancelAnimationFrame(clockRaf.current);
    clockRaf.current = null;
  }, []);

  const runClock = useCallback((step) => {
    stopClock();
    const tick = () => {
      if (step() === false) {
        clockRaf.current = null;
        return;
      }
      clockRaf.current = requestAnimationFrame(tick);
    };
    clockRaf.current = requestAnimationFrame(tick);
  }, [stopClock]);

  const setTimer = useCallback((timer, extra = {}) => {
    setClock((c) => {
      const next = { ...c, timer, glyph: false, ...extra };
      return next.timer === c.timer && next.urgent === c.urgent && next.glyph === c.glyph && next.label === c.label ? c : next;
    });
  }, []);

  /* ------------------------------------------------------------ audio */

  /* The element's volume is the player's setting multiplied by a fade gain, so
     a fade in progress can never be mistaken for -- or overwrite -- the level
     the player chose with the slider. */
  const applyVolume = useCallback(() => {
    const audio = audioRef.current;
    if (audio) audio.volume = Math.max(0, Math.min(1, volumeRef.current.level * fade.current.gain));
  }, []);

  const setVolume = useCallback((level) => {
    const v = Math.max(0, Math.min(1, level));
    const next = { level: v, last: v > 0 ? v : volumeRef.current.last };
    volumeRef.current = next;
    setVolumeState(next);
    saveVolume(Math.round(v * 100));
    if (audioRef.current) audioRef.current.muted = false;
    applyVolume();
  }, [applyVolume]);

  const toggleMute = useCallback(() => {
    const { level, last } = volumeRef.current;
    setVolume(level === 0 ? (last || 0.8) : 0);
  }, [setVolume]);

  /** Drop any fade in flight and put the clip back at the player's own level. */
  const cancelFade = useCallback(() => {
    fade.current.token += 1;
    fade.current.gain = 1;
    applyVolume();
  }, [applyVolume]);

  const fadeOutAudio = useCallback((ms = 500) => {
    const audio = audioRef.current;
    if (!audio) return;
    const token = ++fade.current.token;
    const from = fade.current.gain;
    const started = performance.now();
    const step = () => {
      if (token !== fade.current.token) return; // superseded by a newer fade or a cancel
      const t = (performance.now() - started) / ms;
      if (t >= 1 || audio.paused) {
        audio.pause();
        fade.current.gain = 1;
        applyVolume();
        return;
      }
      fade.current.gain = from * (1 - t);
      applyVolume();
      requestAnimationFrame(step);
    };
    step();
  }, [applyVolume]);

  const endAudioPhase = useCallback(() => {
    clearTimeout(revealFade.current);
    revealFade.current = null;
    wantAudio.current = false;
  }, []);

  const stopAudio = useCallback(() => {
    endAudioPhase();
    cancelFade();
    const audio = audioRef.current;
    if (!audio) return;
    try {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch { /* nothing to stop */ }
  }, [endAudioPhase, cancelFade]);

  /**
   * The reveal is the payoff -- the answer and the artwork with the song still
   * going. The clip is exactly as long as the round, so unless everybody
   * guessed early it has just run out. Start it again from the top rather than
   * reveal in silence, and save the fade for the end of the window. A clip with
   * some left but not enough to cover the reveal is restarted too.
   */
  const playRevealAudio = useCallback((ms) => {
    const audio = audioRef.current;
    if (!audio || !audio.src) return;
    clearTimeout(revealFade.current);
    cancelFade();
    wantAudio.current = true;

    const left = Number.isFinite(audio.duration) ? audio.duration - audio.currentTime : Infinity;
    if (audio.ended || left < ms / 1000) {
      try { audio.currentTime = 0; } catch { /* not seekable yet */ }
    }
    const played = audio.play();
    if (played && played.catch) played.catch(() => {});

    revealFade.current = setTimeout(() => {
      wantAudio.current = false;
      fadeOutAudio(REVEAL_FADE_MS);
    }, Math.max(0, ms - REVEAL_FADE_MS));
  }, [cancelFade, fadeOutAudio]);

  /* ------------------------------------------------------------- chat */

  const addMessage = useCallback((msg) => {
    const id = ++msgId.current;
    setMessages((list) => {
      const next = list.concat({ ...msg, id });
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
  }, []);

  /* ------------------------------------------------------------ state */

  const applyState = useCallback((state) => {
    roomRef.current = state;
    setRoom(state);

    if (state.state === 'lobby' || state.state === 'loading') {
      setView('lobby');
      stopClock();
      if (vizRef.current) vizRef.current.setEmpty();
      stopAudio();
      setRound(null);
      setGuessLive(false);
    } else if (state.state === 'ended') {
      setView('final');
      if (vizRef.current) vizRef.current.setEmpty();
    } else if (!roundRef.current) {
      setView('play');
    }
    if (state.state !== 'loading') setLoadingMessage('');
  }, [stopClock, stopAudio, setRound]);

  /* ------------------------------------------------------------- join */

  const attemptJoin = useCallback((name, password) => {
    setGate((g) => ({ ...g, error: '', busy: true }));
    socket.emit('room:join', { code, name: name || 'Player', password, pid: playerId() }, (res) => {
      if (!res || res.error) {
        setGate((g) => ({
          ...g,
          busy: false,
          // A solo room lets itself in with no gate on screen, so a refusal has
          // nowhere to be read -- put the panel up to carry the message.
          phase: 'open',
          error: (res && res.error) || 'Could not join.',
          ...(res && res.needPassword
            ? { needPassword: true, title: 'Password required', sub: 'This room is locked.' }
            : {})
        }));
        return;
      }
      joinedRef.current = true;
      meRef.current = res.you;
      setMe(res.you);
      if (name) saveName(name);
      if (password) {
        passRef.current = password;
        savePassword(code, password);
      }
      setGate((g) => ({ ...g, phase: 'hidden', busy: false, error: '' }));
      // The click that got us here is our licence to make noise.
      if (!graphRef.current) graphRef.current = createAudioGraph(audioRef.current);
      const graph = graphRef.current;
      if (graph && graph.ctx.state === 'suspended') graph.ctx.resume();
      if (vizRef.current) vizRef.current.setGraph(graph);
      applyState(res.state);
    });
  }, [socket, code, applyState]);

  /* ---------------------------------------------------- socket events */

  useEffect(() => {
    const on = (event, fn) => socket.on(event, fn);

    on('connect', () => {
      if (joinedRef.current) attemptJoin(savedName(), passRef.current); // silent re-join
    });

    on('room:kicked', ({ message }) => {
      joinedRef.current = false;
      setGate((g) => ({ ...g, phase: 'open', error: message || 'You were disconnected.' }));
    });

    on('room:state', applyState);

    on('room:error', ({ message }) => {
      setLobbyError(message);
      setStatus(message, 'bad');
    });

    on('game:loading', ({ message }) => {
      setLobbyError('');
      setLoadingMessage(message);
    });

    on('round:prepare', (data) => {
      const next = {
        index: data.index,
        total: data.total,
        timeLimit: data.timeLimit,
        startAt: null,
        phase: 'prep',
        solved: false,
        wrong: false,
        mode: data.mode || 'classic',
        picked: null,
        skipped: false,
        // Turned up mid-clip: no audio, no points, and so no card to play.
        spectating: !!data.rejoin,
        mask: data.mask || '',
        artist: data.artist || null,
        choices: data.choices || null,
        correctIndex: null,
        reveal: null,
        stamps: []
      };
      setRound(next);
      setView('play');
      stopClock();
      endAudioPhase();
      cancelFade(); // a reveal fade must not carry into the next round's clip
      setChatNote(false);
      setGuessLive(false);

      setClock({ timer: '--', urgent: false, glyph: false, label: `Round ${data.index + 1} of ${data.total}` });
      setCaption(data.rejoin ? 'round in progress' : 'get ready');
      setStatus(data.rejoin ? 'You joined mid-round — sit this one out.' : '');
      const viz = vizRef.current;
      if (viz) {
        viz.setIdle();
        viz.setStamps([]);
      }

      // Nobody has answered the new round yet.
      if (roomRef.current) {
        const cleared = { ...roomRef.current, players: roomRef.current.players.map((p) => ({ ...p, answered: false })) };
        roomRef.current = cleared;
        setRoom(cleared);
      }

      const audio = audioRef.current;
      if (!data.token || !audio) return; // rejoined mid-round: no audio for this one

      let told = false;
      const tellReady = () => {
        if (told) return;
        told = true;
        socket.emit('round:ready');
      };
      audio.oncanplaythrough = tellReady;
      audio.onerror = () => {
        setStatus('Audio failed to load for this round.', 'bad');
        tellReady();
      };
      audio.src = `/a/${data.token}`;
      audio.load();
      setTimeout(tellReady, 6000); // never hold the room up for one slow client
    });

    on('round:countdown', ({ in: ms }) => {
      patchRound({ phase: 'countdown' });
      setCaption('starting');
      const end = Date.now() + ms;
      runClock(() => {
        const left = Math.ceil((end - Date.now()) / 1000);
        setTimer(left > 0 ? String(left) : 'GO');
        return left > -1;
      });
    });

    on('round:start', ({ timeLimit }) => {
      const r = roundRef.current;
      if (!r) return;
      const startAt = Date.now();
      patchRound({ startAt, timeLimit, phase: 'playing' });
      setCaption(r.mode !== 'choice' ? 'seconds' : 'pick the song');
      setGuessLive(true);

      cancelFade();
      wantAudio.current = true;
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = 0;
        const played = audio.play();
        if (played && played.catch) played.catch(() => setStatus('Tap anywhere to enable audio.', 'bad'));
      }
      const viz = vizRef.current;
      if (viz) {
        viz.resume();
        viz.setDeadline(startAt + timeLimit, timeLimit, 'round');
      }

      const end = startAt + timeLimit;
      runClock(() => {
        const left = end - Date.now();
        setTimer(String(Math.max(0, Math.ceil(left / 1000))), { urgent: left > 0 && left <= 5000 });
        return left > 0;
      });
    });

    on('round:answered', ({ correct, points, place, title, artist }) => {
      if (!correct) {
        // Only multiple choice can be wrong and final; a typed miss is just chat.
        patchRound({ wrong: true });
        setStatus('Locked in — that was not it.', 'bad');
        return;
      }
      const r = roundRef.current;
      const patch = { solved: true };
      if (title) patch.mask = title; // you earned the right to see it
      if (artist) patch.artist = artist;
      patchRound(patch);
      const ordinal = place === 1 ? 'First!' : place === 2 ? 'Second!' : place === 3 ? 'Third!' : 'Got it!';
      setStatus(`${ordinal} +${points} points`, 'good');
      // The private-chat note is a typing-round thing: picking a card gives
      // nothing away, so the chat stays open to the room either way.
      const choosing = !!(r && r.mode === 'choice');
      setChatNote(!choosing && !(roomRef.current && roomRef.current.solo));
      setGuessLive(false);
    });

    on('round:hint', ({ mask, artist }) => {
      const r = roundRef.current;
      if (!r || r.solved) return; // don't re-hide a title we already showed
      const patch = {};
      if (mask) patch.mask = mask; // multiple choice sends none
      if (artist) patch.artist = artist;
      patchRound(patch);
    });

    // A private nudge when a guess is nearly right.
    on('chat:nudge', ({ text }) => {
      addMessage({ nudge: true, text });
      setStatus(text, 'warm');
    });

    on('round:progress', ({ pid, answered, of }) => {
      const state = roomRef.current;
      if (state) {
        const next = { ...state, players: state.players.map((p) => (p.pid === pid ? { ...p, answered: true } : p)) };
        roomRef.current = next;
        setRoom(next);
      }
      const r = roundRef.current;
      if (state && !state.solo && r && !r.solved) setStatus(`${answered} of ${of} have got it`);
    });

    on('chat:message', (msg) => {
      addMessage(msg);
      // A solve is also a stamp on the ring, at the moment it happened.
      const r = roundRef.current;
      if (msg.system && msg.kind === 'solve' && r && r.phase === 'playing' && typeof msg.seconds === 'number') {
        const stamps = r.stamps.filter((s) => s.pid !== msg.pid).concat({
          pid: msg.pid,
          name: msg.name,
          at: (msg.seconds * 1000) / (r.timeLimit || 30000)
        });
        patchRound({ stamps });
      }
    });

    on('round:reveal', ({ track, results, last, nextIn, correctIndex }) => {
      stopClock();
      playRevealAudio(nextIn);
      setChatNote(false);
      setGuessLive(false);

      const r = roundRef.current;
      patchRound({
        phase: 'reveal',
        solved: true,
        mask: track.title,
        artist: track.artist,
        correctIndex: correctIndex == null ? null : correctIndex,
        reveal: { track, results, last }
      });
      setCaption(track.artist);
      if (!track.artwork) setTimer('♪', { urgent: false, glyph: true });
      else setTimer('', { urgent: false });

      const state = roomRef.current;
      const mine = results.find((x) => x.pid === meRef.current);
      const got = results.filter((x) => x.correct).length;
      if (mine && mine.correct) setStatus(`Correct — +${mine.points} points`, 'good');
      else if (state && state.solo) setStatus("Didn't get that one.", 'bad');
      else setStatus(`${got} of ${results.length} got it.`, got ? '' : 'bad');

      if (state) {
        const players = results.map((x) => ({
          ...(state.players.find((p) => p.pid === x.pid) || {}),
          pid: x.pid,
          name: x.name,
          score: x.score,
          answered: x.answered
        }));
        const next = { ...state, players };
        roomRef.current = next;
        setRoom(next);
      }

      // The ring keeps meaning something between rounds -- it counts down to
      // the next one, in aqua so it reads as a different clock.
      const viz = vizRef.current;
      if (viz) {
        viz.setDeadline(Date.now() + nextIn, nextIn, 'reveal');
        const first = r && [...r.stamps].sort((a, b) => a.at - b.at)[0];
        if (got) viz.burst(first ? huesRef.current(first.pid) : '#2FE0C8');
      }
      const label = last ? 'Final scores' : 'Next song';
      const end = Date.now() + nextIn;
      runClock(() => {
        const left = Math.ceil((end - Date.now()) / 1000);
        if (left <= 0) return false;
        setClock((c) => (c.label === `${label} in ${left}` ? c : { ...c, label: `${label} in ${left}` }));
        return true;
      });
    });

    on('game:over', (data) => {
      stopClock();
      stopAudio();
      if (vizRef.current) vizRef.current.setEmpty();
      setRound(null);
      setGuessLive(false);
      setSummary(data || {});
      setView('final');
    });

    on('game:reset', () => {
      setRound(null);
      stopClock();
      stopAudio();
      if (vizRef.current) vizRef.current.setEmpty();
      setGuessLive(false);
      setView('lobby');
      setLobbyError('');
      setStatus('');
    });

    socket.connect();
    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      stopClock();
    };
    // Registered once for the life of the page; everything they read is a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  /* The stamps the ring draws, in each solver's colour. */
  useEffect(() => {
    const viz = vizRef.current;
    if (!viz) return;
    viz.setStamps(round && round.stamps.length
      ? round.stamps.map((s) => ({ color: hues(s.pid), label: [...String(s.name || '?')][0].toUpperCase(), at: s.at }))
      : []);
  }, [round, hues]);

  /* ------------------------------------------------- first contact */

  /*
   * What kind of room this is decides whether there is a gate at all.
   *
   *   - A multiplayer room asks for a name: you are about to appear in a list.
   *   - A daily run needs no name -- it plays under the Discord account, which
   *     the server reads off the session cookie. The gate stays anyway, because
   *     a click is what earns the browser permission to play audio, and a
   *     countdown that started before the tab could make a sound would cost the
   *     player the first round of a game they only get one shot at.
   *   - A single player game lets itself in. Nothing starts until Start game is
   *     pressed, and that press is the gesture that unlocks audio.
   */
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/room/${encodeURIComponent(code)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => {
        if (cancelled || joinedRef.current) return;
        if (!info) return setGate((g) => ({ ...g, phase: 'open' })); // gone: let the gate say so
        if (info.solo && !info.daily) {
          attemptJoin(savedName() || 'You', passRef.current);
          return;
        }
        if (info.daily) {
          setGate((g) => ({
            ...g,
            phase: 'open',
            daily: true,
            title: 'Daily challenge',
            sub: 'Five songs, thirty seconds each. Tap to start — the clock begins as soon as the first clip loads.'
          }));
          return;
        }
        setGate((g) => ({ ...g, phase: 'open', needPassword: g.needPassword || !!info.hasPassword }));
      })
      .catch(() => !cancelled && setGate((g) => ({ ...g, phase: 'open' })));
    return () => { cancelled = true; };
  }, [code, attemptJoin]);

  /* Catalogues. Each is a convenience: the room works without any of them. */
  useEffect(() => {
    fetch('/api/packs').then((r) => r.json()).then(setPacks).catch(() => {});
    fetch('/api/modes').then((r) => r.json()).then((cfg) => {
      if (cfg && Array.isArray(cfg.modes) && cfg.modes.length) setModes(cfg.modes);
    }).catch(() => {});
    fetch('/api/difficulty').then((r) => r.json()).then((cfg) => setDiffLevels(cfg.levels)).catch(() => {});
  }, []);

  /* Recovery path if the browser blocked the first play() call. */
  useEffect(() => {
    const onClick = () => {
      if (vizRef.current) vizRef.current.resume();
      const audio = audioRef.current;
      if (wantAudio.current && audio && audio.paused && audio.src) audio.play().catch(() => {});
    };
    document.addEventListener('click', onClick, { passive: true });
    return () => document.removeEventListener('click', onClick);
  }, []);

  /* ---------------------------------------------------------- actions */

  const emit = useCallback((event, payload) => socket.emit(event, payload), [socket]);

  const actions = useMemo(() => ({
    join: (name, password) => attemptJoin(name, password || passRef.current),
    start: () => emit('room:start'),
    again: () => emit('room:again'),
    leave: () => {
      emit('room:leave');
      location.href = '/';
    },
    setPacks: (packIds) => emit('room:pack', { packIds }),
    setMix: (mix) => emit('room:mix', { mix }),
    setMode: (mode) => emit('room:mode', { mode }),
    setRounds: (rounds) => emit('room:rounds', { rounds }),
    setDifficulty: (value) => emit('room:difficulty', { value }),
    kick: (pid) => emit('room:kick', { pid }),
    kickVote: (yes) => emit('room:kickvote', { yes }),
    say: (text) => {
      const t = String(text || '').trim();
      if (t) emit('chat:send', { text: t });
    },
    /** One card each: the pick is sent once and the row locks behind it. */
    choose: (index) => {
      const r = roundRef.current;
      if (!r || r.mode !== 'choice' || r.picked != null || r.phase !== 'playing' || r.spectating || r.solved || r.wrong) return;
      patchRound({ picked: index });
      emit('round:choose', { index });
    },
    /** Solo only -- in a room the clock belongs to everyone. */
    skip: () => {
      const r = roundRef.current;
      if (!r || r.skipped) return;
      patchRound({ skipped: true });
      emit('round:skip');
    },
    setVolume,
    toggleMute
  }), [attemptJoin, emit, patchRound, setVolume, toggleMute]);

  /** Refs the page hands its <audio> and visualiser to. */
  const attachAudio = useCallback((el) => {
    audioRef.current = el;
    if (el) applyVolume();
  }, [applyVolume]);
  const attachViz = useCallback((viz) => {
    vizRef.current = viz;    if (!viz) return;
    viz.setGraph(graphRef.current);
    // A visualiser mounted mid-round picks the round's state up from here.
    const r = roundRef.current;
    if (r && r.phase === 'playing' && r.startAt) viz.setDeadline(r.startAt + r.timeLimit, r.timeLimit, 'round');
    else if (r && r.phase !== 'reveal') viz.setIdle();
  }, []);

  return {
    code,
    me,
    room,
    round,
    view,
    summary,
    status,
    clock,
    caption,
    messages,
    chatNote,
    guessLive,
    loadingMessage,
    lobbyError,
    gate,
    volume,
    packs,
    modes,
    diffLevels,
    hues,
    actions,
    attachAudio,
    attachViz
  };
}
