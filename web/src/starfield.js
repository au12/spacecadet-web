// Slow drifting starfield shown while there is no table to look at.

export class Starfield {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.stars = [];
    this.running = false;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._frame = this._frame.bind(this);
    new ResizeObserver(() => this._resize()).observe(canvas);
  }

  _resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (!w || !h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    const count = Math.round((w * h) / 9000);
    this.stars = Array.from({ length: count }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      z: Math.random() ** 2, tw: Math.random() * Math.PI * 2,
    }));
    if (!this.running) this._draw(0);
  }

  start() {
    this.canvas.classList.add('on');
    if (this.running) return;
    this.running = true;
    requestAnimationFrame(this._frame);
  }

  stop() {
    this.canvas.classList.remove('on');
    this.running = false;
  }

  _frame(t) {
    if (!this.running) return;
    this._draw(t);
    if (!this.reduced) requestAnimationFrame(this._frame);
  }

  _draw(t) {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const drift = this.reduced ? 0 : t * 0.006;
    for (const s of this.stars) {
      const x = (s.x - drift * (0.2 + s.z * 1.6)) % canvas.width;
      const px = x < 0 ? x + canvas.width : x;
      const a = 0.35 + 0.65 * s.z * (0.75 + 0.25 * Math.sin(s.tw + t * 0.002 * (1 + s.z)));
      const r = 0.5 + s.z * 1.6;
      ctx.fillStyle = s.z > 0.82 ? `rgba(255,214,140,${a})` : `rgba(190,180,255,${a})`;
      ctx.fillRect(px, s.y, r, r);
    }
  }
}
