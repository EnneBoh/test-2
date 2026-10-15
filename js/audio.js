/**
 * Audio — tiny synthesized sound effects (no asset files).
 * The AudioContext is created lazily on the first user gesture (autoplay policy).
 */
export class Sound {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.master = null;
  }

  /** Must be called from a user gesture at least once. */
  unlock() {
    // Autoplay policy: never create the context before the user has interacted with the page.
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.7;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  _ready() { return this.enabled && this.ctx && this.ctx.state !== 'closed'; }

  _tone({ freq, to = freq, dur = 0.15, type = 'sine', gain = 0.2, delay = 0, attack = 0.004 }) {
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  _noise({ dur = 0.06, gain = 0.1, freq = 900, delay = 0 }) {
    const c = this.ctx, t = c.currentTime + delay;
    const len = Math.max(1, (c.sampleRate * dur) | 0);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
  }

  /** Soft wooden "tok" when a sphere lands. strength 0..1 scales loudness. */
  land(strength = 1) {
    if (!this._ready()) return;
    const s = Math.min(1, Math.max(0.15, strength));
    this._tone({ freq: 210, to: 95, dur: 0.14, gain: 0.22 * s });
    this._tone({ freq: 640, to: 320, dur: 0.05, gain: 0.05 * s, type: 'triangle' });
    this._noise({ dur: 0.05, gain: 0.12 * s, freq: 1100 });
  }

  click() {
    if (!this._ready()) return;
    this._tone({ freq: 520, to: 780, dur: 0.06, gain: 0.07, type: 'triangle' });
  }

  error() {
    if (!this._ready()) return;
    this._tone({ freq: 180, to: 120, dur: 0.14, gain: 0.1, type: 'square' });
  }

  undo() {
    if (!this._ready()) return;
    this._tone({ freq: 520, to: 300, dur: 0.12, gain: 0.08, type: 'triangle' });
  }

  win() {
    if (!this._ready()) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      this._tone({ freq: f, dur: 0.5, gain: 0.12, type: 'triangle', delay: i * 0.11 }));
    this._tone({ freq: 261.6, dur: 0.9, gain: 0.1, delay: 0.3 });
  }

  draw() {
    if (!this._ready()) return;
    [392, 330, 262].forEach((f, i) => this._tone({ freq: f, dur: 0.3, gain: 0.1, type: 'triangle', delay: i * 0.14 }));
  }
}
