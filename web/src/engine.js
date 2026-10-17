// Thin wrapper around the WebAssembly game core (engine/web/web_main.cpp).

// Mirrors enum ScpState in engine/web/web_api.h.
const S = {
  READY: 0, GAME_MODE: 1, DEMO: 2, PAUSED: 3, PLAYER_COUNT: 4, CURRENT_PLAYER: 5,
  BALL_NUMBER: 6, MAX_BALLS: 7, TILT_LOCK: 8, CHEATS_USED: 9, CHEAT_MODE: 10,
  FULL_TILT: 11, RESOLUTION: 12, MULTIBALL: 13, LAUNCH_ENABLED: 14, NUDGE: 15,
  MUSIC_AVAILABLE: 16, SCREEN_PTR: 17, SCREEN_W: 18, SCREEN_H: 19, STRIDE: 20,
  TABLE_W: 21, OFFSET_X: 22, OFFSET_Y: 23, DIRTY: 24, DIRTY_X: 25, DIRTY_Y: 26,
  DIRTY_W: 27, DIRTY_H: 28, SCORES: 29, GAMEOVER_SEQ: 37, GAMEOVER_COUNT: 38,
  GAMEOVER_ELIGIBLE: 39, GAMEOVER_DEMO: 40, GAMEOVER_SCORES: 41, SIZE: 49,
};

export const Binding = {
  left: 0, right: 1, plunger: 2, bumpLeft: 3, bumpRight: 4, tilt: 5,
};

export const GameMode = { InGame: 1, GameOver: 2 };

const E9 = 1e9;

export class Engine {
  /**
   * @param {object} opts
   * @param {string} opts.moduleUrl  URL of pinball.mjs
   * @param {string} [opts.wasmUrl]   URL of pinball.wasm
   * @param {Promise<WebAssembly.Module>} [opts.wasmModule] precompiled module
   * @param {object} opts.audio      Module.scpAudio implementation
   * @param {(flags:number,title:string,msg:string)=>void} [opts.onMessage]
   */
  static async create({ moduleUrl, wasmUrl, wasmModule, audio, onMessage }) {
    const { default: createPinball } = await import(/* @vite-ignore */ moduleUrl);
    const logs = [];
    const module = await createPinball({
      locateFile: (path) => (path.endsWith('.wasm') && wasmUrl ? wasmUrl : path),
      // Reuse a module compiled while the game data was downloading.
      instantiateWasm: wasmModule
        ? (imports, receive) => {
          Promise.resolve(wasmModule)
            .then((mod) => WebAssembly.instantiate(mod, imports).then((inst) => receive(inst, mod)))
            .catch((err) => console.error('WebAssembly instantiation failed', err));
          return {};
        }
        : undefined,
      print: (s) => logs.push(s),
      printErr: (s) => { logs.push(s); console.warn('[engine]', s); },
      scpAudio: audio,
      onEngineMessage: onMessage,
    });
    return new Engine(module, logs);
  }

  constructor(module, logs) {
    this.m = module;
    this.logs = logs;
    this.ready = false;
    this.root = '';
    this.state = {
      ready: false, mode: 0, demo: false, paused: false, players: 1, currentPlayer: 0,
      ball: 0, maxBalls: 3, tiltLock: false, cheatsUsed: false, cheatMode: false,
      fullTilt: false, resolution: 0, multiball: 0, launchEnabled: false, nudge: 0,
      musicAvailable: false, screen: { ptr: 0, w: 0, h: 0, stride: 0 }, tableW: 0,
      offsetX: 0, offsetY: 0, dirty: null, scores: [0, 0, 0, 0],
      gameOver: { seq: 0, count: 0, eligible: false, demo: false, scores: [0, 0, 0, 0] },
    };
    this._dirty = { x: 0, y: 0, w: 0, h: 0 };
  }

  /** Writes game files into the virtual file system. Paths are upper-cased. */
  mount(root, files) {
    const FS = this.m.FS;
    const mkdirp = (path) => {
      let cur = '';
      for (const part of path.split('/').filter(Boolean)) {
        cur += '/' + part;
        try { FS.mkdir(cur); } catch { /* exists */ }
      }
    };
    mkdirp(root);
    for (const [path, bytes] of files) {
      const full = `${root}/${path.toUpperCase()}`;
      mkdirp(full.slice(0, full.lastIndexOf('/')));
      FS.writeFile(full, bytes);
    }
    this.root = root.endsWith('/') ? root : root + '/';
  }

  /** @returns {number} 0 on success */
  init({ attract = true } = {}) {
    const len = this.m.lengthBytesUTF8(this.root) + 1;
    const ptr = this.m._malloc(len);
    this.m.stringToUTF8(this.root, ptr, len);
    const rc = this.m._scp_init(ptr, attract ? 1 : 0);
    this.m._free(ptr);
    this.ready = rc === 0;
    return rc;
  }

  tick(ms) { return this.ready ? this.m._scp_tick(ms) : 0; }

  /** Reads the engine state into a reused object. */
  read() {
    const st = this.state;
    if (!this.ready) return st;
    const base = this.m._scp_state() >> 2;
    const h = this.m.HEAP32;
    st.ready = h[base + S.READY] === 1;
    st.mode = h[base + S.GAME_MODE];
    st.demo = h[base + S.DEMO] === 1;
    st.paused = h[base + S.PAUSED] === 1;
    st.players = h[base + S.PLAYER_COUNT];
    st.currentPlayer = h[base + S.CURRENT_PLAYER];
    st.ball = h[base + S.BALL_NUMBER];
    st.maxBalls = h[base + S.MAX_BALLS];
    st.tiltLock = h[base + S.TILT_LOCK] !== 0;
    st.cheatsUsed = h[base + S.CHEATS_USED] !== 0;
    st.cheatMode = h[base + S.CHEAT_MODE] !== 0;
    st.fullTilt = h[base + S.FULL_TILT] === 1;
    st.resolution = h[base + S.RESOLUTION];
    st.multiball = h[base + S.MULTIBALL];
    st.launchEnabled = h[base + S.LAUNCH_ENABLED] === 1;
    st.nudge = h[base + S.NUDGE] / 1000;
    st.musicAvailable = h[base + S.MUSIC_AVAILABLE] === 1;
    st.screen.ptr = h[base + S.SCREEN_PTR] >>> 0;
    st.screen.w = h[base + S.SCREEN_W];
    st.screen.h = h[base + S.SCREEN_H];
    st.screen.stride = h[base + S.STRIDE];
    st.tableW = h[base + S.TABLE_W];
    st.offsetX = h[base + S.OFFSET_X];
    st.offsetY = h[base + S.OFFSET_Y];
    if (h[base + S.DIRTY]) {
      const d = this._dirty;
      d.x = h[base + S.DIRTY_X]; d.y = h[base + S.DIRTY_Y];
      d.w = h[base + S.DIRTY_W]; d.h = h[base + S.DIRTY_H];
      st.dirty = d;
    } else {
      st.dirty = null;
    }
    for (let i = 0; i < 4; i++) {
      st.scores[i] = h[base + S.SCORES + i * 2] + h[base + S.SCORES + i * 2 + 1] * E9;
    }
    const go = st.gameOver;
    go.seq = h[base + S.GAMEOVER_SEQ];
    go.count = h[base + S.GAMEOVER_COUNT];
    go.eligible = h[base + S.GAMEOVER_ELIGIBLE] === 1;
    go.demo = h[base + S.GAMEOVER_DEMO] === 1;
    for (let i = 0; i < 4; i++) {
      go.scores[i] = h[base + S.GAMEOVER_SCORES + i * 2] + h[base + S.GAMEOVER_SCORES + i * 2 + 1] * E9;
    }
    return st;
  }

  /** Live view of the virtual screen (BGRA bytes). */
  heap() { return this.m.HEAPU8; }

  input(binding, down) { if (this.ready) this.m._scp_input(binding, down ? 1 : 0); }
  key(ch, down) { if (this.ready) this.m._scp_key(ch, down ? 1 : 0); }
  newGame(players) { if (this.ready) this.m._scp_new_game(players); }
  attract() { if (this.ready) this.m._scp_attract(); }
  setPaused(paused) { if (this.ready) this.m._scp_set_paused(paused ? 1 : 0); }
  invalidate() { if (this.ready) this.m._scp_invalidate(); }

  setSound(enabled, stereo, channels = 8) {
    this.m._scp_set_sound(enabled ? 1 : 0, 128, stereo ? 1 : 0, channels);
  }
  setMusic(enabled) { this.m._scp_set_music(enabled ? 1 : 0, 128); }
  setPlayers(n) { this.m._scp_set_players(n); }
  setResolution(r) { this.m._scp_set_resolution(r); }
  setPhysicsRate(ups) { this.m._scp_set_physics_rate(ups); }

  /** Seeds the in-game top-5 table (used by the table's own score roll). */
  setHighScores(entries) {
    for (let i = 0; i < 5; i++) {
      const e = entries[i];
      const name = e ? e.name : '';
      const len = this.m.lengthBytesUTF8(name) + 1;
      const ptr = this.m._malloc(len);
      this.m.stringToUTF8(name, ptr, len);
      // The table's roll only understands the low 9 digits.
      const score = e ? Math.min(e.score, 999999999) : 0;
      this.m._scp_set_high_score(i, ptr, score);
      this.m._free(ptr);
    }
  }

  version() { return this.m.UTF8ToString(this.m._scp_version()); }
}
