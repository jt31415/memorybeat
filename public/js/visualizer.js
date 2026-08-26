/*
 * MemoryBeat's radial meter: circular frequency bars, peak-hold caps and a
 * countdown ring.
 *
 * The ring is driven by a deadline rather than by a progress value pushed in
 * from a timer. The old version was fed from a 100ms setInterval while the
 * canvas redrew at 60fps, so the arc advanced in ~3 degree steps -- visibly
 * chunky. Now draw() reads the clock itself, so the sweep is exact on every
 * frame no matter how coarsely the text clock ticks.
 */

/* Cool at rest, warm under load: bars stay near-monochrome when quiet and only
   pick up amber and then ember as they get loud, like a real level meter. The
   ramp is deliberately back-loaded (see HEAT_GAMMA) so ordinary levels read as
   near-white and the colour stays an event rather than a wash. */
const BAR_STOPS = [
  { at: 0.00, c: [196, 210, 238] },
  { at: 0.40, c: [226, 224, 226] },
  { at: 0.74, c: [247, 185, 62] },
  { at: 1.00, c: [255, 106, 61] }
];

const HEAT_GAMMA = 2.1;

/* Amber for most of the round; the shift to ember and then red is the warning,
   so it must not start until the time genuinely is short. */
const RING_STOPS = [
  { at: 0.00, c: [255, 93, 108] },   // out of time
  { at: 0.12, c: [255, 106, 61] },
  { at: 0.34, c: [247, 185, 62] },
  { at: 1.00, c: [247, 185, 62] }
];

// The between-rounds ring reads as cool -- lifted well above the bloom's own
// indigo, which at ring weight was too dark to see against the background.
const REVEAL_RING = [138, 168, 255];

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

class Visualizer {
  constructor(canvas, centerEl) {
    this.canvas = canvas;
    this.centerEl = centerEl || null;
    this.ctx = canvas.getContext('2d');
    this.analyser = null;
    this.data = null;

    this.progress = 1;          // 1 = full time left
    this.deadline = null;       // { endAt, duration, mode }
    this.mode = 'idle';
    this.ringAlpha = 1;         // dips through 0 when the mode changes
    this.pendingMode = null;

    this.level = 0;             // smoothed loudness, drives the idle pulse
    this.bars = new Float32Array(96);
    this.peaks = new Float32Array(96);
    this.running = false;
    this.phase = 0;
    this.lastFrame = 0;

    this.resize();
    window.addEventListener('resize', () => this.resize());
    // The canvas starts life inside a display:none panel, so its first
    // measurement is 0x0 -- watch the box instead of trusting that one.
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

  /**
   * The one radius that clears the whole centre overlay.
   *
   * The bars all start on this circle. It has to be the *circumscribing* radius
   * (the box's half-diagonal, not its half-height), because anything smaller
   * would leave the overlay's corners sticking out past the start circle and
   * the bars would have to dodge them per-angle -- which is what draws a
   * visible square into the middle of a round meter.
   */
  measureCenter() {
    if (!this.centerEl) return;
    const r = this.centerEl.getBoundingClientRect();
    this.clearR = r.width > 0 && r.height > 0
      ? Math.hypot(r.width / 2, r.height / 2) + 8
      : 0;
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

  /** Wire an <audio> element through an analyser. Safe to call repeatedly. */
  attach(audioEl) {
    if (this.audioCtx) return this.audioCtx.resume?.();
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.audioCtx = new AC();
      this.source = this.audioCtx.createMediaElementSource(audioEl);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.75;
      this.data = new Uint8Array(this.analyser.frequencyBinCount);
      this.source.connect(this.analyser);
      this.analyser.connect(this.audioCtx.destination);
    } catch (err) {
      // No Web Audio: the ring still animates, just without real frequencies.
      console.warn('[viz] audio graph unavailable:', err.message);
      this.analyser = null;
    }
  }

  resume() {
    if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume();
  }

  /* ------------------------------------------------------------- countdown */

  _switchMode(mode) {
    if (this.mode === mode) return;
    // Cross the ring through zero opacity so a jump in the arc's length reads
    // as a new ring arriving rather than the old one teleporting.
    this.pendingMode = mode;
    this.ringAlpha = Math.min(this.ringAlpha, 1);
  }

  /**
   * Hand the ring a deadline and let it interpolate. `endAt`/`duration` are in
   * Date.now() milliseconds, matching what the server timings give us.
   */
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
  }

  geometry() {
    // Capped so the meter does not grow without limit on a big monitor -- past
    // a point a wider ring just means more empty middle.
    const m = Math.min(this.w, this.h, 560);
    const ringW = 3;
    const ring = m / 2 - ringW / 2 - 3;      // outermost stroke, inside the box
    const gap = Math.max(8, m * 0.035);      // bars-to-ring stand-off

    // One start circle for every bar, breathing very slightly with the level.
    // Floored at a fraction of the box so it still reads as a disc when the
    // overlay is small. Deliberately NOT clamped back inside the ring: on a
    // squat window there is no room for overlay + bars + ring, and the right
    // answer is to drop the bars (barMax falls to 0 and they are skipped) --
    // not to pull them in over the top of the clock.
    const inner = Math.max(m * 0.26, this.clearR || 0) * (1 + this.level * 0.05);
    // 9 = the bars' 5px stand-off from the disc plus their 4px minimum length.
    const barMax = Math.max(0, ring - gap - inner - 9);
    return { ring, ringW, gap, inner, barMax };
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
    if (this.analyser) {
      this.analyser.getByteFrequencyData(this.data);
      const bins = this.data.length;
      let sum = 0;
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
      this.level += (sum / n - this.level) * 0.15;
    } else {
      this.phase += 0.05;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const t = this.phase + i * 0.22;
        const target = 0.18 + 0.16 * (Math.sin(t) + Math.sin(t * 0.53) * 0.7);
        this.bars[i] += (target - this.bars[i]) * 0.2;
        sum += this.bars[i];
      }
      this.level += (sum / n - this.level) * 0.15;
    }

    // Peak-hold caps, the one detail that makes this read as a meter rather
    // than as an animation: they snap up instantly and sink at a fixed rate.
    // Kept fast -- a slow fall leaves the caps hanging so far off the bars that
    // they stop reading as caps and start reading as speckle.
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
    const { ring: ringR, ringW, gap, inner, barMax } = this.geometry();

    // Cool bloom behind everything: the warm bars need something cold to sit
    // against, otherwise the amber just looks like dirty white.
    const glowR = Math.min(inner * 1.5, ringR);
    const glow = ctx.createRadialGradient(cx, cy, glowR * 0.1, cx, cy, glowR);
    glow.addColorStop(0, `rgba(91,124,255,${0.10 + this.level * 0.16})`);
    glow.addColorStop(0.55, `rgba(91,124,255,${0.03 + this.level * 0.05})`);
    glow.addColorStop(1, 'rgba(91,124,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
    ctx.fill();

    // The guide traces the same circle the bars start from, so the two read as
    // one shape rather than a disc with bars floating off it.
    ctx.strokeStyle = `rgba(196,210,238,${0.09 + this.level * 0.1})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, inner, 0, Math.PI * 2);
    ctx.stroke();

    // frequency bars, mirrored around the vertical axis
    const n = this.bars.length;
    const barW = Math.max(2, Math.min(w, h) * 0.008);
    ctx.lineCap = 'round';
    for (let side = 0; side < 2; side++) {
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const angle = -Math.PI / 2 + (side ? -1 : 1) * t * Math.PI;
        // Every bar starts on the same circle, then gets trimmed so it still
        // stops short of the countdown ring.
        const from = inner + 5;
        const room = ringR - gap - from;
        if (room <= 0) continue;
        const amp = this.bars[i];
        const len = Math.min(4 + amp * barMax, room);

        // Bass is nudged a shade warmer than treble at equal loudness, which
        // is roughly how a meter feels and keeps the ring from looking flat.
        const heat = Math.pow(Math.min(1, amp * (1.06 - 0.16 * t)), HEAT_GAMMA);
        const [r, g, b] = ramp(BAR_STOPS, heat);

        ctx.lineWidth = barW;
        ctx.strokeStyle = `rgba(${r},${g},${b},${0.2 + amp * 0.7})`;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * from, cy + Math.sin(angle) * from);
        ctx.lineTo(cx + Math.cos(angle) * (from + len), cy + Math.sin(angle) * (from + len));
        ctx.stroke();

        // peak-hold cap
        const pk = this.peaks[i];
        if (pk > amp + 0.1) {
          const pd = Math.min(4 + pk * barMax, room);
          const [pr, pg, pb] = ramp(BAR_STOPS, Math.pow(Math.min(1, pk * (1.06 - 0.16 * t)), HEAT_GAMMA));
          ctx.lineWidth = barW * 0.85;
          ctx.strokeStyle = `rgba(${pr},${pg},${pb},0.32)`;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(angle) * (from + pd), cy + Math.sin(angle) * (from + pd));
          ctx.lineTo(cx + Math.cos(angle) * (from + pd + 1.5), cy + Math.sin(angle) * (from + pd + 1.5));
          ctx.stroke();
        }
      }
    }

    // countdown ring -- track first, then the live arc
    ctx.lineWidth = ringW;
    ctx.strokeStyle = 'rgba(196,210,238,0.08)';
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
    ctx.stroke();

    if (this.mode === 'idle') {
      ctx.strokeStyle = `rgba(247,185,62,${0.3 * this.ringAlpha})`;
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      ctx.stroke();
    } else if (this.progress > 0.0005) {
      const [r, g, b] = this.mode === 'reveal'
        ? REVEAL_RING
        : ramp(RING_STOPS, this.progress);
      const start = -Math.PI / 2;
      const end = start + Math.PI * 2 * this.progress;

      ctx.strokeStyle = `rgba(${r},${g},${b},${this.ringAlpha})`;
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, start, end);
      ctx.stroke();

      // A lit head at the leading edge: it makes a slow sweep legible even
      // when the arc itself has barely moved since the last frame.
      const hx = cx + Math.cos(end) * ringR;
      const hy = cy + Math.sin(end) * ringR;
      const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, ringW * 4);
      halo.addColorStop(0, `rgba(${r},${g},${b},${0.85 * this.ringAlpha})`);
      halo.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(hx, hy, ringW * 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = `rgba(255,255,255,${0.9 * this.ringAlpha})`;
      ctx.beginPath();
      ctx.arc(hx, hy, ringW * 0.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

window.Visualizer = Visualizer;
