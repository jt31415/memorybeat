/*
 * MemoryBeat's radial meter: circular frequency bars, peak-hold caps, a
 * countdown ring, and the stamps of whoever has solved the round.
 *
 * The ring is driven by a deadline rather than by a progress value pushed in
 * from a timer. draw() reads the clock itself, so the sweep is exact on every
 * frame no matter how coarsely the text clock ticks.
 *
 * The stamps are the ring's second job. Each one lands where the ring's head
 * was at the moment that player got the song, so as the ring keeps draining
 * they are left behind on the empty track: the round's race, drawn on its clock.
 */

/* Cool at rest, warm under load: bars stay near-monochrome when quiet and only
   pick up butter, then tangerine, then rose as they get loud, like a real level
   meter. The ramp is back-loaded (see HEAT_GAMMA) so ordinary levels read as
   near-white and the colour stays an event rather than a wash. */
const BAR_STOPS = [
  { at: 0.00, c: [207, 202, 211] },
  { at: 0.45, c: [232, 226, 222] },
  { at: 0.74, c: [255, 211, 107] },
  { at: 0.90, c: [255, 122, 47] },
  { at: 1.00, c: [255, 77, 109] }
];

const HEAT_GAMMA = 1.9;

/* Butter for most of the round; the shift to tangerine and then rose is the
   warning, so it must not start until the time genuinely is short. */
const RING_STOPS = [
  { at: 0.00, c: [255, 77, 109] },   // out of time
  { at: 0.12, c: [255, 122, 47] },
  { at: 0.34, c: [255, 211, 107] },
  { at: 1.00, c: [255, 211, 107] }
];

// Between rounds the ring counts down to the next song in aqua, so it reads as
// a different clock rather than as the round starting over.
const REVEAL_RING = [47, 224, 200];
const TRACK = 'rgba(245, 241, 234, 0.08)';
const INK = '#111014';

const BURST_MS = 1400;

function ramp(stops, t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].at) {
      const a = stops[i - 1];
      const b = stops[i];
      const k = (t - a.at) / (b.at - a.at || 1);
      return [
        Math.round(a.c[0] + (b.c[0] - a.c[0]) * k),
        Math.round(a.c[1] + (b.c[1] - a.c[1]) * k),
        Math.round(a.c[2] + (b.c[2] - a.c[2]) * k)
      ];
    }
  }
  return stops[stops.length - 1].c;
}

/**
 * Wire an <audio> element through an analyser, once.
 *
 * A media element can only ever be handed to Web Audio a single time, so the
 * graph belongs to the page rather than to a visualiser -- the round screen
 * comes and goes, and each visualiser it mounts borrows the same analyser.
 * Returns null where there is no Web Audio; the ring still animates without it.
 */
export function createAudioGraph(audioEl) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || !audioEl) return null;
  try {
    const ctx = new AC();
    const source = ctx.createMediaElementSource(audioEl);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    return { ctx, analyser };
  } catch (err) {
    console.warn('[viz] audio graph unavailable:', err.message);
    return null;
  }
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return [245, 241, 234];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export default class Visualizer {
  constructor(canvas, centerEl) {
    this.canvas = canvas;
    this.centerEl = centerEl || null;
    this.ctx = canvas.getContext('2d');
    this.graph = null;
    this.analyser = null;
    this.data = null;

    this.progress = 1;          // 1 = full time left
    this.deadline = null;       // { endAt, duration }
    this.mode = 'idle';
    this.ringAlpha = 1;         // dips through 0 when the mode changes
    this.pendingMode = null;

    this.level = 0;             // smoothed loudness
    this.bars = new Float32Array(88);
    this.peaks = new Float32Array(88);
    this.running = false;
    this.phase = 0;
    this.lastFrame = 0;

    this.stamps = [];           // { color, label, at } -- at: fraction of the round elapsed
    this.burstAt = 0;
    this.burstColor = [182, 240, 106];

    this._onResize = () => this.resize();
    this.resize();
    window.addEventListener('resize', this._onResize);
    // The canvas can start life inside a hidden panel, so its first measurement
    // may be 0x0 -- watch the box instead of trusting that one.
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas);
      if (this.centerEl) {
        this._cro = new ResizeObserver(() => this.measureCenter());
        this._cro.observe(this.centerEl);
      }
    }
    this.measureCenter();
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    if (this._ro) this._ro.disconnect();
    if (this._cro) this._cro.disconnect();
  }

  /**
   * The one radius that clears the centre disc.
   *
   * The bars all start on this circle, so it is the disc's own radius plus a
   * stand-off. The disc is round, so its half-width is all it takes.
   */
  measureCenter() {
    if (!this.centerEl) return;
    const r = this.centerEl.getBoundingClientRect();
    this.clearR = r.width > 0 ? r.width / 2 + 8 : 0;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(rect.width, 1);
    this.h = Math.max(rect.height, 1);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Read frequencies from an audio graph made by createAudioGraph. */
  setGraph(graph) {
    this.graph = graph || null;
    this.analyser = graph ? graph.analyser : null;
    this.data = this.analyser ? new Uint8Array(this.analyser.frequencyBinCount) : null;
  }

  resume() {
    const ctx = this.graph && this.graph.ctx;
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  /* ------------------------------------------------------------- countdown */

  _switchMode(mode) {
    if (this.mode === mode) return;
    // Cross the ring through zero opacity so a jump in the arc's length reads
    // as a new ring arriving rather than the old one teleporting.
    this.pendingMode = mode;
    this.ringAlpha = Math.min(this.ringAlpha, 1);
  }

  /** Hand the ring a deadline and let it interpolate (Date.now() ms). */
  setDeadline(endAt, duration, mode = 'round') {
    this._switchMode(mode);
    this.deadline = { endAt, duration: Math.max(1, duration) };
  }

  /** Ring sits full and quiet -- used while a round is being prepared. */
  setIdle() {
    this._switchMode('idle');
    this.deadline = null;
    this.progress = 1;
  }

  /** Ring empties out; no clock behind it. */
  setEmpty() {
    this.deadline = null;
    this.progress = 0;
    this.stamps = [];
  }

  /** Who has solved the round so far: [{ color, label, at }]. */
  setStamps(stamps) {
    this.stamps = Array.isArray(stamps) ? stamps : [];
  }

  /** The reveal's shockwave, in the colour of whoever got there first. */
  burst(color) {
    this.burstColor = hexToRgb(color);
    this.burstAt = performance.now();
  }

  geometry() {
    // Capped so the meter does not grow without limit on a big monitor -- past
    // a point a wider ring just means more empty middle.
    const m = Math.min(this.w, this.h, 760);
    const ringW = Math.max(5, m * 0.016);
    const stampR = Math.max(10, m * 0.032);
    // Inset far enough that a stamp sitting on the ring stays on the canvas.
    const ring = m / 2 - Math.max(ringW / 2, stampR) - 3;
    const gap = Math.max(10, m * 0.04);      // bars-to-ring stand-off

    // One start circle for every bar, breathing very slightly with the level.
    // Not clamped back inside the ring: on a squat window the right answer is
    // to drop the bars (barMax falls to 0) rather than draw them over the clock.
    const inner = Math.max(m * 0.26, this.clearR || 0) * (1 + this.level * 0.04);
    const barMax = Math.max(0, ring - gap - inner - 9);
    return { m, ring, ringW, stampR, gap, inner, barMax };
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (now) => {
      if (!this.running) return;
      this.draw(now || 0);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  sample(dt) {
    const n = this.bars.length;
    let sum = 0;
    if (this.analyser) {
      this.analyser.getByteFrequencyData(this.data);
      const bins = this.data.length;
      for (let i = 0; i < n; i++) {
        // Logarithmic-ish spread so bass doesn't hog every bar.
        const from = Math.floor(Math.pow(i / n, 1.7) * bins);
        const to = Math.max(from + 1, Math.floor(Math.pow((i + 1) / n, 1.7) * bins));
        let peak = 0;
        for (let j = from; j < to && j < bins; j++) peak = Math.max(peak, this.data[j]);
        const target = (peak / 255) * (0.55 + 0.75 * (i / n));
        this.bars[i] += (target - this.bars[i]) * 0.35;
        sum += this.bars[i];
      }
    } else {
      this.phase += 0.05;
      for (let i = 0; i < n; i++) {
        const t = this.phase + i * 0.22;
        const target = 0.18 + 0.16 * (Math.sin(t) + Math.sin(t * 0.53) * 0.7);
        this.bars[i] += (target - this.bars[i]) * 0.2;
        sum += this.bars[i];
      }
    }
    this.level += (sum / n - this.level) * 0.15;

    // Peak-hold caps, the one detail that makes this read as a meter rather
    // than as an animation: they snap up instantly and sink at a fixed rate.
    const fall = 1.5 * dt;
    for (let i = 0; i < n; i++) {
      this.peaks[i] = this.bars[i] > this.peaks[i]
        ? this.bars[i]
        : Math.max(this.bars[i], this.peaks[i] - fall);
    }
  }

  /** Resolve the ring's progress from the clock, on this exact frame. */
  tickClock() {
    if (!this.deadline) return;
    const left = this.deadline.endAt - Date.now();
    this.progress = Math.max(0, Math.min(1, left / this.deadline.duration));
  }

  draw(now) {
    const { ctx, w, h } = this;
    if (w < 8 || h < 8) return; // not laid out yet

    const dt = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.05) : 0.016;
    this.lastFrame = now;

    ctx.clearRect(0, 0, w, h);
    this.sample(dt);
    this.tickClock();

    // ring cross-fade bookkeeping
    if (this.pendingMode) {
      this.ringAlpha -= dt * 6;
      if (this.ringAlpha <= 0) {
        this.mode = this.pendingMode;
        this.pendingMode = null;
        this.ringAlpha = 0;
      }
    } else if (this.ringAlpha < 1) {
      this.ringAlpha = Math.min(1, this.ringAlpha + dt * 5);
    }

    const cx = w / 2;
    const cy = h / 2;
    const { ring: ringR, ringW, stampR, gap, inner, barMax } = this.geometry();

    this.drawBurst(now, cx, cy, inner, ringR);

    // A faint warm bloom that swells with the music -- just enough that loud
    // bars have something to sit in.
    const glowR = Math.min(inner * 1.5, ringR);
    const glow = ctx.createRadialGradient(cx, cy, glowR * 0.2, cx, cy, glowR);
    glow.addColorStop(0, `rgba(255,211,107,${0.03 + this.level * 0.08})`);
    glow.addColorStop(1, 'rgba(255,211,107,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
    ctx.fill();

    // frequency bars, mirrored around the vertical axis
    const n = this.bars.length;
    const barW = Math.max(2, Math.min(w, h) * 0.009);
    ctx.lineCap = 'round';
    for (let side = 0; side < 2; side++) {
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const angle = -Math.PI / 2 + (side ? -1 : 1) * t * Math.PI;
        const from = inner + 5;
        const room = ringR - gap - from;
        if (room <= 0) continue;
        const amp = this.bars[i];
        const len = Math.min(4 + amp * barMax, room);

        // Bass is nudged a shade warmer than treble at equal loudness, which
        // is roughly how a meter feels and keeps the ring from looking flat.
        const heat = Math.pow(Math.min(1, amp * (1.06 - 0.16 * t)), HEAT_GAMMA);
        const [r, g, b] = ramp(BAR_STOPS, heat);

        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        ctx.lineWidth = barW;
        ctx.strokeStyle = `rgba(${r},${g},${b},${0.3 + amp * 0.7})`;
        ctx.beginPath();
        ctx.moveTo(cx + cos * from, cy + sin * from);
        ctx.lineTo(cx + cos * (from + len), cy + sin * (from + len));
        ctx.stroke();

        // peak-hold cap
        const pk = this.peaks[i];
        if (pk > amp + 0.1) {
          const pd = Math.min(4 + pk * barMax, room);
          const [pr, pg, pb] = ramp(BAR_STOPS, Math.pow(Math.min(1, pk * (1.06 - 0.16 * t)), HEAT_GAMMA));
          ctx.lineWidth = barW * 0.85;
          ctx.strokeStyle = `rgba(${pr},${pg},${pb},0.35)`;
          ctx.beginPath();
          ctx.moveTo(cx + cos * (from + pd), cy + sin * (from + pd));
          ctx.lineTo(cx + cos * (from + pd + 1.5), cy + sin * (from + pd + 1.5));
          ctx.stroke();
        }
      }
    }

    // countdown ring -- track first, then the live arc
    ctx.lineWidth = ringW;
    ctx.strokeStyle = TRACK;
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
    ctx.stroke();

    const start = -Math.PI / 2;
    if (this.mode === 'idle') {
      ctx.strokeStyle = `rgba(255,211,107,${0.3 * this.ringAlpha})`;
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      ctx.stroke();
    } else if (this.progress > 0.0005) {
      const [r, g, b] = this.mode === 'reveal' ? REVEAL_RING : ramp(RING_STOPS, this.progress);
      const end = start + Math.PI * 2 * this.progress;

      ctx.strokeStyle = `rgba(${r},${g},${b},${this.ringAlpha})`;
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, start, end);
      ctx.stroke();

      // A lit head at the leading edge: it makes a slow sweep legible even
      // when the arc itself has barely moved since the last frame.
      const hx = cx + Math.cos(end) * ringR;
      const hy = cy + Math.sin(end) * ringR;
      const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, ringW * 2.6);
      halo.addColorStop(0, `rgba(${r},${g},${b},${0.7 * this.ringAlpha})`);
      halo.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(hx, hy, ringW * 2.6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = `rgba(255,255,255,${0.95 * this.ringAlpha})`;
      ctx.beginPath();
      ctx.arc(hx, hy, ringW * 0.42, 0, Math.PI * 2);
      ctx.fill();
    }

    this.drawStamps(cx, cy, ringR, stampR);
  }

  /** Solvers, stamped where the ring's head was when they got it. */
  drawStamps(cx, cy, ringR, stampR) {
    if (!this.stamps.length) return;
    const { ctx } = this;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.round(stampR * 1.05)}px "Big Shoulders Display", sans-serif`;
    for (const s of this.stamps) {
      const at = Math.max(0, Math.min(1, s.at));
      const a = -Math.PI / 2 + Math.PI * 2 * (1 - at);
      const x = cx + Math.cos(a) * ringR;
      const y = cy + Math.sin(a) * ringR;
      // An ink gap around each stamp so it sits on the ring rather than in it.
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.arc(x, y, stampR + 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(x, y, stampR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = INK;
      ctx.fillText(s.label, x, y + stampR * 0.06);
    }
  }

  drawBurst(now, cx, cy, inner, ringR) {
    if (!this.burstAt) return;
    const t = (now - this.burstAt) / BURST_MS;
    if (t >= 1 || t < 0) {
      if (t >= 1) this.burstAt = 0;
      return;
    }
    const { ctx } = this;
    const [r, g, b] = this.burstColor;
    for (let k = 0; k < 3; k++) {
      const local = t - k * 0.12;
      if (local <= 0) continue;
      const ease = 1 - Math.pow(1 - Math.min(1, local), 3);
      const radius = inner + (ringR - inner) * ease;
      ctx.lineWidth = Math.max(1, 5 - k * 1.5) * (1 - ease * 0.6);
      ctx.strokeStyle = `rgba(${r},${g},${b},${(0.75 - k * 0.2) * (1 - ease)})`;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
