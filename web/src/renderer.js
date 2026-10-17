// Presents the engine's software-rendered virtual screen with WebGL2.
//
// The engine draws the whole cabinet (table + score panel) into one BGRA
// bitmap. We upload only the rectangle that changed since the last frame and
// draw the table and the side panel as two independent quads, which lets the
// page re-flow them (side by side, or stacked for portrait screens) and apply
// the nudge shake to the table alone, exactly like the original.

const VERT = `#version 300 es
uniform vec4 u_dst;   // destination rect, device px, origin top-left
uniform vec4 u_src;   // source rect, texels
uniform vec2 u_view;  // drawing buffer size
out vec2 v_tex;
out vec2 v_pos;
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 p = u_dst.xy + c * u_dst.zw;
  vec2 ndc = p / u_view * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  v_tex = u_src.xy + c * u_src.zw;
  v_pos = c;
}`;

const FRAG_HEAD = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_texSize;
uniform vec2 u_scale;     // output pixels per source texel
uniform vec4 u_clamp;     // texel-space sampling bounds of this region
uniform float u_dim;
in vec2 v_tex;
in vec2 v_pos;
out vec4 o_color;

vec3 fetchTexel(vec2 t) {
  t = clamp(t, u_clamp.xy, u_clamp.zw);
  return texture(u_tex, t / u_texSize).bgr; // engine memory is BGRA
}

// Sharp-bilinear: nearest-neighbour inside each texel, a one-output-pixel
// linear blend on texel edges. Crisp at any (non-integer) scale, no shimmer.
vec2 sharpCoord(vec2 t, vec2 scale) {
  vec2 s = max(floor(scale), vec2(1.0));
  vec2 base = floor(t);
  vec2 d = fract(t) - 0.5;
  vec2 range = 0.5 - 0.5 / s;
  vec2 f = (d - clamp(d, -range, range)) * s + 0.5;
  return base + f;
}

vec3 dim(vec3 c) {
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 muted = vec3(l) * 0.32 + vec3(0.012, 0.010, 0.045);
  return mix(c, muted, u_dim);
}
`;

const FILTERS = {
  sharp: `void main() { o_color = vec4(dim(fetchTexel(sharpCoord(v_tex, u_scale))), 1.0); }`,
  smooth: `void main() { o_color = vec4(dim(fetchTexel(v_tex)), 1.0); }`,
  pixel: `void main() { o_color = vec4(dim(fetchTexel(floor(v_tex) + 0.5)), 1.0); }`,
  crt: `void main() {
    vec3 c = fetchTexel(sharpCoord(v_tex, u_scale));
    // Scanlines only once there are enough output rows per texel to draw them.
    float strength = clamp((u_scale.y - 1.6) / 2.0, 0.0, 1.0);
    float scan = 0.5 + 0.5 * cos(6.2831853 * (fract(v_tex.y) - 0.5));
    float peak = max(c.r, max(c.g, c.b));
    float beam = mix(scan, 1.0, peak * 0.5);
    c *= mix(1.0, 0.3 + 0.85 * beam, strength);
    float m = mod(gl_FragCoord.x, 3.0);
    vec3 mask = vec3(m < 1.0 ? 1.0 : 0.8, (m >= 1.0 && m < 2.0) ? 1.0 : 0.8, m >= 2.0 ? 1.0 : 0.8);
    c *= mix(vec3(1.0), mask, strength * 0.75);
    c *= 1.0 + 0.22 * strength;
    vec2 q = v_pos - 0.5;
    c *= 1.0 - dot(q, q) * 0.45 * strength;
    o_color = vec4(dim(c), 1.0);
  }`,
};

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed');
  }
  return sh;
}

function program(gl, fragBody) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG_HEAD + fragBody));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p) || 'program link failed');
  }
  const u = {};
  for (const name of ['u_dst', 'u_src', 'u_view', 'u_tex', 'u_texSize', 'u_scale', 'u_clamp', 'u_dim']) {
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

/**
 * Positions the table and the side panel inside a viewport.
 * All values are CSS pixels. Returns null until the screen size is known.
 */
export function computeLayout(vw, vh, screenW, screenH, tableW, { mode = 'auto', integer = false } = {}) {
  if (!screenW || !screenH || !vw || !vh) return null;
  const bw = tableW || Math.round(screenW * 0.61), bh = screenH;
  const sw = screenW - bw, sh = screenH;
  const snap = (s) => (integer && s >= 1 ? Math.floor(s) : s);

  // Side by side, like the original window.
  const sl = snap(Math.min(vw / screenW, vh / screenH));
  // Stacked: table on top, panel underneath at >= 60% of the table's scale.
  const sp = snap(Math.min(vw / bw, vh / (bh + 0.6 * sh)));

  const portrait = mode === 'portrait' || (mode === 'auto' && sp >= sl * 1.3);
  if (!portrait) {
    const w = screenW * sl, h = screenH * sl;
    const x = (vw - w) / 2, y = (vh - h) / 2;
    const board = { x, y, w: bw * sl, h: bh * sl, scale: sl };
    const side = { x: x + bw * sl, y, w: sw * sl, h: sh * sl, scale: sl };
    return { portrait: false, board, side, panel: { ...side }, scale: sl };
  }

  const ss = Math.min((vh - bh * sp) / sh, vw / sw, sp);
  const total = bh * sp + sh * ss;
  const y = Math.max(0, (vh - total) / 2);
  const board = { x: (vw - bw * sp) / 2, y, w: bw * sp, h: bh * sp, scale: sp };
  const side = { x: (vw - sw * ss) / 2, y: y + bh * sp, w: sw * ss, h: sh * ss, scale: ss };
  // Menus may use the full width below the table.
  const below = vh - (board.y + board.h);
  const u = Math.min(below / sh, vw / sw);
  const pw = Math.min(vw, Math.max(sw * u, Math.min(vw - 16, sw * u * 1.45)));
  const panel = { x: (vw - pw) / 2, y: board.y + board.h, w: pw, h: below, scale: u };
  return { portrait: true, board, side, panel, scale: sp };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.filter = 'sharp';
    this.layoutOptions = { mode: 'auto', integer: false };
    this.layout = null;
    this.dpr = 1;
    this.cssW = 0;
    this.cssH = 0;
    this.texW = 0;
    this.texH = 0;
    this.needsDraw = true;
    this.dim = 0;
    this.boardOnly = false;
    this.lastOffset = '';
    this.onLayout = null;
    this.gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false,
      // No "desynchronized": it trades a few ms of latency for tearing, and a
      // tearing pinball is worse than a frame of delay.
    });
    if (this.gl) {
      this._initGL();
    } else {
      this.ctx2d = canvas.getContext('2d', { alpha: false });
    }
    this._observe();
  }

  get backend() { return this.gl ? 'webgl2' : 'canvas2d'; }

  _initGL() {
    const gl = this.gl;
    this.programs = {};
    for (const [name, body] of Object.entries(FILTERS)) this.programs[name] = program(gl, body);
    this.vao = gl.createVertexArray();
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.texW = this.texH = 0;
      this._initGL();
      this.needsDraw = true;
      this.forceUpload = true;
    });
  }

  _observe() {
    const apply = (cssW, cssH, devW, devH) => {
      this.cssW = cssW;
      this.cssH = cssH;
      this.dpr = devW / Math.max(1, cssW);
      if (this.canvas.width !== devW || this.canvas.height !== devH) {
        this.canvas.width = devW;
        this.canvas.height = devH;
      }
      this.layout = null;
      this.needsDraw = true;
    };
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const css = e.contentBoxSize?.[0];
        const dev = e.devicePixelContentBoxSize?.[0];
        const cw = css ? css.inlineSize : e.contentRect.width;
        const ch = css ? css.blockSize : e.contentRect.height;
        const dpr = window.devicePixelRatio || 1;
        apply(cw, ch, dev ? dev.inlineSize : Math.round(cw * dpr), dev ? dev.blockSize : Math.round(ch * dpr));
      }
    });
    try {
      ro.observe(this.canvas, { box: 'device-pixel-content-box' });
    } catch {
      ro.observe(this.canvas);
    }
  }

  setFilter(name) {
    if (FILTERS[name] && name !== this.filter) {
      this.filter = name;
      this.needsDraw = true;
    }
  }

  setLayoutOptions(opts) {
    this.layoutOptions = { ...this.layoutOptions, ...opts };
    this.layout = null;
    this.needsDraw = true;
  }

  setDim(v) {
    if (Math.abs(v - this.dim) > 0.001) {
      this.dim = v;
      this.needsDraw = true;
    }
  }

  setBoardOnly(v) {
    if (v !== this.boardOnly) {
      this.boardOnly = v;
      this.needsDraw = true;
    }
  }

  /** Recomputes the layout if the viewport or screen changed. */
  ensureLayout(st) {
    if (this.layout && this._layoutKey === `${st.screen.w}x${st.screen.h}:${st.tableW}`) return this.layout;
    this.layout = computeLayout(this.cssW, this.cssH, st.screen.w, st.screen.h, st.tableW, this.layoutOptions);
    this._layoutKey = `${st.screen.w}x${st.screen.h}:${st.tableW}`;
    this.needsDraw = true;
    if (this.layout && this.onLayout) this.onLayout(this.layout);
    return this.layout;
  }

  /**
   * @param st     engine state (Engine.read())
   * @param heap   engine HEAPU8
   * @returns {boolean} whether anything was drawn
   */
  draw(st, heap) {
    if (!st.ready || !st.screen.w) return false;
    const layout = this.ensureLayout(st);
    if (!layout) return false;
    if (this.gl) return this._drawGL(st, heap, layout);
    return this._draw2D(st, heap, layout);
  }

  _upload(st, heap) {
    const gl = this.gl;
    const { ptr, w, h, stride } = st.screen;
    if (w !== this.texW || h !== this.texH) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.texW = w;
      this.texH = h;
      this.forceUpload = true;
    }
    let d = st.dirty;
    if (this.forceUpload) {
      d = { x: 0, y: 0, w, h };
      this.forceUpload = false;
    }
    if (!d) return false;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, stride);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, d.x, d.y, d.w, d.h, gl.RGBA, gl.UNSIGNED_BYTE,
      heap, ptr + (d.y * stride + d.x) * 4);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    this.stats.uploadedPixels += d.w * d.h;
    return true;
  }

  _drawGL(st, heap, layout) {
    if (this.lost) return false;
    this.stats ||= { uploadedPixels: 0, draws: 0 };
    const uploaded = this._upload(st, heap);
    const offsetKey = `${st.offsetX},${st.offsetY}`;
    if (!uploaded && !this.needsDraw && offsetKey === this.lastOffset) return false;
    this.lastOffset = offsetKey;
    this.needsDraw = false;

    const gl = this.gl;
    const { p, u } = this.programs[this.filter];
    const dpr = this.dpr;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(p);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(u.u_tex, 0);
    gl.uniform2f(u.u_view, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.u_texSize, this.texW, this.texH);
    gl.uniform1f(u.u_dim, this.dim);

    const tw = st.tableW;
    const quad = (rect, sx, sw, ox, oy) => {
      // Snap to device pixels so sharp filtering stays crisp.
      const x = Math.round((rect.x + ox * rect.scale) * dpr);
      const y = Math.round((rect.y + oy * rect.scale) * dpr);
      const w = Math.round(rect.w * dpr), h = Math.round(rect.h * dpr);
      gl.uniform4f(u.u_dst, x, y, w, h);
      gl.uniform4f(u.u_src, sx, 0, sw, this.texH);
      gl.uniform2f(u.u_scale, w / sw, h / this.texH);
      gl.uniform4f(u.u_clamp, sx + 0.5, 0.5, sx + sw - 0.5, this.texH - 0.5);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    quad(layout.board, 0, tw, st.offsetX, st.offsetY);
    if (!this.boardOnly) quad(layout.side, tw, this.texW - tw, 0, 0);
    this.stats.draws++;
    return true;
  }

  // Fallback for browsers without WebGL2: slower, but playable.
  _draw2D(st, heap, layout) {
    const { ptr, w, h } = st.screen;
    if (!this.img || this.img.width !== w || this.img.height !== h) {
      this.img = new ImageData(w, h);
      this.offscreen = new OffscreenCanvas(w, h);
      this.offctx = this.offscreen.getContext('2d');
      this.forceUpload = true;
    }
    const d = this.forceUpload ? { x: 0, y: 0, w, h } : st.dirty;
    this.forceUpload = false;
    const offsetKey = `${st.offsetX},${st.offsetY}`;
    if (!d && !this.needsDraw && offsetKey === this.lastOffset) return false;
    this.lastOffset = offsetKey;
    this.needsDraw = false;
    if (d) {
      const src = heap, dst = this.img.data;
      for (let y = d.y; y < d.y + d.h; y++) {
        let si = ptr + (y * w + d.x) * 4, di = (y * w + d.x) * 4;
        for (let x = 0; x < d.w; x++, si += 4, di += 4) {
          dst[di] = src[si + 2]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si]; dst[di + 3] = 255;
        }
      }
      this.offctx.putImageData(this.img, 0, 0, d.x, d.y, d.w, d.h);
    }
    const c = this.ctx2d, dpr = this.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#000';
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    c.imageSmoothingEnabled = this.filter === 'smooth';
    c.filter = this.dim > 0.01 ? `brightness(${1 - this.dim * 0.7}) saturate(${1 - this.dim})` : 'none';
    const tw = st.tableW;
    const b = layout.board, s = layout.side;
    c.drawImage(this.offscreen, 0, 0, tw, h, (b.x + st.offsetX * b.scale) * dpr, (b.y + st.offsetY * b.scale) * dpr, b.w * dpr, b.h * dpr);
    if (!this.boardOnly) c.drawImage(this.offscreen, tw, 0, w - tw, h, s.x * dpr, s.y * dpr, s.w * dpr, s.h * dpr);
    c.filter = 'none';
    return true;
  }
}
