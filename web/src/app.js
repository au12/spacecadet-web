import './styles.css';
import { Engine, Binding } from './engine.js';
import { Renderer } from './renderer.js';
import { AudioEngine } from './audio.js';
import { Input, keyName } from './input.js';
import { Settings, ACTIONS, DEFAULT_KEYS } from './settings.js';
import { discover, detect, expandFiles, filesFromDrop, importDetected, deleteLocalData, KINDS } from './data.js';
import { Scores, formatScore } from './scores.js';
import { Starfield } from './starfield.js';

/* global __BUILD__ */
const BUILD = __BUILD__;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
};

const icon = (id) => {
  const t = document.createElement('template');
  t.innerHTML = `<svg aria-hidden="true"><use href="#${id}"/></svg>`;
  return t.content.firstChild;
};

const DIM = { boot: 0.5, data: 0.5, home: 0.14, playing: 0, paused: 0.55, over: 0.3 };
const MENU_KEYS = ['left', 'right', 'plunger', 'tilt'];

class App {
  constructor() {
    this.settings = new Settings();
    this.audio = new AudioEngine();
    this.renderer = new Renderer($('#screen'));
    this.stars = new Starfield($('#stars'));
    this.scores = new Scores();
    this.input = new Input($('#stage'), {
      onAction: (a, down) => this.onAction(a, down),
      onCommand: (c) => this.command(c),
      onChar: (ch, down) => { if (this.state === 'playing') this.engine?.key(ch, down); },
      onDevice: (kind, pad) => this.onDevice(kind, pad),
    });
    this.input.attachTouch($('#touch'));
    this.state = 'boot';
    this.engine = null;
    this.table = null;
    this.tables = [];
    this.banks = [];
    this.dim = 0.5;
    this.last = 0;
    this.fps = { frames: 0, steps: 0, since: 0 };
    this.gameOverSeq = 0;
    this.tiltLock = false;
    this.scoreScope = 'shared';
    this.sfxMuted = false;
    this.touchSeen = matchMedia('(hover: none) and (pointer: coarse)').matches;
    this.wasmModule = null;
    this.renderer.onLayout = () => this.placeSlot();
    this.tiltMeter = $('#tilt-meter');
    this.meterShown = false;
    this._frame = this._frame.bind(this);
  }

  // ---------------------------------------------------------------------
  // Start-up

  async start() {
    this.applySettings();
    this.bindUi();
    this.setState('boot');
    this.stars.start();
    this.boot('Warming up the table…', 0.05);

    // Compile the engine while game data is located and downloaded.
    this.wasmModule = (WebAssembly.compileStreaming
      ? WebAssembly.compileStreaming(fetch(BUILD.engineWasm)).catch(() => fetch(BUILD.engineWasm).then((r) => r.arrayBuffer()).then((b) => WebAssembly.compile(b)))
      : fetch(BUILD.engineWasm).then((r) => r.arrayBuffer()).then((b) => WebAssembly.compile(b)));
    this.wasmModule.catch(() => {});

    requestAnimationFrame(this._frame);
    window.addEventListener('resize', () => this.placeSlot());
    await this.refreshTables();

    const saved = this.settings.get('game.table');
    const table = this.tables.find((t) => t.id === saved) || this.tables[0];
    if (table) await this.loadTable(table);
    else this.setState('data');

    if ('serviceWorker' in navigator && window.isSecureContext && !location.hostname.match(/^(localhost|127\.)/)) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  async refreshTables() {
    const found = await discover();
    this.tables = found.tables;
    this.banks = found.banks;
    this.scores.serverAvailable = !!found.server?.leaderboard;
    this.serverInfo = found.server;
    if (!this.scores.serverAvailable) this.scoreScope = 'local';
    this.renderTableSeg();
  }

  boot(text, progress) {
    $('#boot-text').textContent = text;
    if (progress !== undefined) {
      $('#boot-bar').style.width = `${Math.round(progress * 100)}%`;
      $('#panel-boot .meter').setAttribute('aria-valuenow', Math.round(progress * 100));
    }
  }

  async loadTable(table) {
    const label = `${KINDS[table.kind].edition}`;
    this.engine = null;
    this.audio.halt(-1);
    this.audio.haltMusic();
    this.setState('boot');
    try {
      this.boot(`Loading ${label}…`, 0.08);
      const files = await table.load((p) => this.boot(`Loading ${label}…`, 0.08 + p * 0.72));
      this.boot('Starting the engine…', 0.85);
      const module = this.wasmModule;
      const engine = await Engine.create({
        moduleUrl: new URL(BUILD.engineModule, document.baseURI).href,
        wasmModule: module,
        audio: this.audio,
        onMessage: (flags, title, msg) => this.onEngineMessage(flags, title, msg),
      });
      this.audio.sounds.clear();
      this.audio.tracks.clear();
      engine.mount(`/tables/${table.kind}`, files);
      this.configureEngine(engine);
      const rc = engine.init({ attract: true });
      if (rc !== 0) throw new Error('The table files are incomplete or damaged.');
      this.engine = engine;
      this.table = table;
      this.settings.set('game.table', table.id);
      const st = engine.read();
      this.gameOverSeq = st.gameOver.seq;
      this.configureMusic();
      await this.syncEngineScores();
      this.boot('Ready', 1);
      this.stars.stop();
      $('#screen').classList.add('on');
      this.setState('home');
      this.renderHome();
    } catch (err) {
      console.error(err);
      this.toast(err.message || String(err), 'error', 6000);
      this.setState('data');
    }
  }

  configureEngine(engine) {
    const s = this.settings.data;
    engine.setSound(true, s.audio.stereo, 8);
    engine.setMusic(false);
    engine.setPlayers(s.game.players);
    engine.setResolution(s.display.resolution);
    engine.setPhysicsRate(s.game.physics);
  }

  pickBank() {
    const pref = this.settings.get('audio.bank');
    const bundled = BUILD.soundfont ? { url: BUILD.soundfont, name: BUILD.soundfontName } : null;
    const own = this.banks.find((b) => /^gm\.dls$/i.test(b.name)) || this.banks[0];
    if (pref === 'bundled') return bundled || (own && { url: own.url, name: own.name });
    return (own && { url: own.url, name: own.name }) || bundled;
  }

  configureMusic() {
    const bank = this.pickBank();
    this.audio.configureMusic({ bankUrl: bank?.url || null, bankName: bank?.name || '' });
  }

  async syncEngineScores() {
    if (!this.engine || !this.table) return;
    const { list } = await this.scores.best(this.table.kind);
    this.engine.setHighScores(list.slice(0, 5));
  }

  // ---------------------------------------------------------------------
  // State machine

  setState(next) {
    const prev = this.state;
    this.state = next;
    document.body.className = next + (this.touchSeen ? ' touch' : '');
    this.input.setMode(next === 'playing' ? 'game' : 'menu');
    this.renderer.setBoardOnly(next === 'home' || next === 'boot' || next === 'data');

    const inGame = next === 'playing' || next === 'paused' || next === 'over';
    this.audio.setMuted({ sfx: !inGame || this.sfxMuted, music: !inGame });
    if (this.engine) this.engine.setMusic(inGame && this.settings.get('audio.musicOn'));

    const panel = { boot: 'boot', data: 'data', home: 'home', paused: 'pause', over: 'over', playing: null }[next];
    this.showPanel(panel, { shutter: next === 'playing' && prev !== 'playing' });
    this.updateTouch();
    this.updateWakeLock();
    this.placeSlot();
    if (next === 'data') this.stars.start();
  }

  showPanel(name, { shutter = false } = {}) {
    const panels = $$('#slot .panel');
    for (const p of panels) {
      const on = p.dataset.panel === name;
      if (on) {
        p.classList.remove('leaving');
        if (p.hidden) {
          p.hidden = false;
          p.classList.remove('entering');
          void p.offsetWidth;
          p.classList.add('entering');
        }
      } else if (!p.hidden) {
        if (shutter) {
          p.classList.add('leaving');
          setTimeout(() => {
            if (p.classList.contains('leaving')) {
              p.hidden = true;
              p.classList.remove('leaving');
            }
          }, 430);
        } else {
          p.hidden = true;
        }
      }
    }
    if (name) {
      const panel = $(`#slot [data-panel="${name}"]`);
      requestAnimationFrame(() => {
        if (!panel.contains(document.activeElement) && !$('#settings').open) {
          (panel.querySelector('[data-autofocus]') || panel.querySelector('[data-nav]:not([hidden])'))?.focus({ preventScroll: true });
        }
      });
    } else if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
  }

  placeSlot() {
    const slot = $('#slot');
    const L = this.renderer.layout;
    let r;
    const free = !(L && this.engine && this.state !== 'boot' && this.state !== 'data');
    slot.classList.toggle('free', free);
    if (!free) {
      r = L.portrait ? L.panel : L.side;
      slot.style.setProperty('--slot-x', `${r.x}px`);
      slot.style.setProperty('--slot-y', `${r.y}px`);
      slot.style.setProperty('--slot-tx', '0 0');
    } else {
      const vh = window.innerHeight, vw = window.innerWidth;
      const h = Math.min(vh * 0.9, 560, (vw - 24) * (416 / 235));
      r = { w: (h * 235) / 416, h: 'auto', scale: h / 416 };
      slot.style.setProperty('--slot-x', '50%');
      slot.style.setProperty('--slot-y', '50%');
      slot.style.setProperty('--slot-tx', '-50% -50%');
    }
    slot.style.setProperty('--slot-w', `${r.w}px`);
    slot.style.setProperty('--slot-h', r.h === 'auto' ? 'auto' : `${r.h}px`);
    slot.style.setProperty('--u', String(r.scale));

    // Tilt meter hugs the table's left edge.
    if (L) {
      const b = L.board, w = Math.max(4, Math.round(b.scale * 3));
      const outside = b.x >= w + 10;
      const tm = $('#tilt-meter');
      tm.style.setProperty('--tm-x', `${outside ? b.x - w - 6 : b.x + 6}px`);
      tm.style.setProperty('--tm-y', `${b.y + b.h * 0.5}px`);
      tm.style.setProperty('--tm-w', `${w}px`);
      tm.style.setProperty('--tm-h', `${b.h * 0.34}px`);
      const fps = $('#fps');
      fps.style.left = `${Math.max(6, b.x + 6)}px`;
      fps.style.top = `${Math.max(4, b.y + 4)}px`;
    }
  }

  play() {
    if (!this.engine || this.state !== 'home') return;
    this.audio._unlock();
    this.engine.newGame(this.settings.get('game.players'));
    this.last = 0;
    this.setState('playing');
  }

  /** Lets go of every flipper/plunger in the engine (it ignores input while paused). */
  releaseEngineInputs() {
    for (const b of Object.values(Binding)) this.engine?.input(b, false);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.input.releaseAll();
    this.engine.setPaused(true);
    const st = this.engine.read();
    const who = st.players > 1 ? `Player ${st.currentPlayer + 1}, ` : '';
    const ball = st.ball ? `ball ${st.ball}` : 'between balls';
    const line = `${who}${ball}: ${formatScore(st.scores[st.currentPlayer])}`;
    $('#pause-score').textContent = line.charAt(0).toUpperCase() + line.slice(1);
    this.setState('paused');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.engine.setPaused(false);
    this.releaseEngineInputs();
    this.last = 0;
    this.setState('playing');
  }

  restart() {
    if (!this.engine) return;
    this.input.releaseAll();
    this.engine.newGame(this.settings.get('game.players'));
    this.releaseEngineInputs();
    this.last = 0;
    this.setState('playing');
  }

  goHome() {
    if (!this.engine) return;
    this.engine.attract();
    this.setState('home');
    this.renderHome();
  }

  // ---------------------------------------------------------------------
  // Frame loop

  _frame(ts) {
    requestAnimationFrame(this._frame);
    const dt = this.last ? Math.min(100, ts - this.last) : 0;
    this.last = ts;
    this.input.poll(ts);

    const target = DIM[this.state] ?? 0;
    this.dim += (target - this.dim) * Math.min(1, dt / 110);
    if (Math.abs(target - this.dim) < 0.004) this.dim = target;
    this.renderer.setDim(this.dim);

    const engine = this.engine;
    if (!engine) return;
    const steps = engine.tick(dt);
    const st = engine.read();
    this.observe(st);
    this.renderer.draw(st, engine.heap());

    if (this.settings.data.display.fps) {
      const f = this.fps;
      f.frames++;
      f.steps += steps;
      if (!f.since) f.since = ts;
      if (ts - f.since >= 500) {
        const secs = (ts - f.since) / 1000;
        $('#fps').textContent = `${Math.round(f.frames / secs)} fps\n${Math.round(f.steps / secs)} physics steps/s`;
        f.frames = f.steps = 0;
        f.since = ts;
      }
    }
  }

  observe(st) {
    if (st.gameOver.seq !== this.gameOverSeq) {
      this.gameOverSeq = st.gameOver.seq;
      if (this.state === 'playing' && !st.gameOver.demo) {
        const snapshot = { ...st.gameOver, scores: st.gameOver.scores.slice() };
        // Let the table play its game-over light show before the panel drops in.
        setTimeout(() => this.onGameOver(snapshot), 1500);
      }
    }
    if (st.tiltLock && !this.tiltLock && this.state === 'playing') this.input.rumble(1, 1, 500);
    this.tiltLock = st.tiltLock;

    const tm = this.tiltMeter;
    const showMeter = this.settings.data.display.tiltMeter && this.state === 'playing' && (st.nudge > 0.02 || st.tiltLock);
    if (showMeter !== this.meterShown) {
      this.meterShown = showMeter;
      tm.classList.toggle('on', showMeter);
    }
    if (showMeter) {
      const n = st.tiltLock ? 1 : Math.min(1, st.nudge);
      tm.style.setProperty('--nudge', n.toFixed(3));
      tm.classList.toggle('warn', n >= 0.5);
      tm.classList.toggle('danger', n >= 0.85);
    }
  }

  // ---------------------------------------------------------------------
  // Input

  onAction(action, down) {
    if (this.state !== 'playing' || !this.engine) return;
    this.engine.input(Binding[action], down);
    if (down && (action === 'tilt' || action === 'bumpLeft' || action === 'bumpRight')) this.input.rumble(0.25, 0.6, 90);
  }

  onDevice(kind, pad) {
    if (kind === 'touch' && !this.touchSeen) {
      this.touchSeen = true;
      document.body.classList.add('touch');
      this.updateTouch();
      this.renderKeyLegends();
    }
    if (kind === 'keyboard' && !this.keyboardSeen) {
      this.keyboardSeen = true;
      if (this.touchSeen) this.renderKeyLegends();
    }
    if (kind === 'gamepad' && pad) {
      const name = (pad.id || 'Controller').replace(/\s*\(.*$/, '').slice(0, 40);
      this.toast(`${name} connected`);
    }
  }

  updateTouch() {
    const mode = this.settings.get('controls.touch');
    const on = this.state === 'playing' && (mode === 'on' || (mode === 'auto' && this.touchSeen));
    $('#touch').hidden = !on;
  }

  async updateWakeLock() {
    const want = this.state === 'playing' && !document.hidden;
    try {
      if (want && !this.wakeLock && navigator.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
      } else if (!want && this.wakeLock) {
        await this.wakeLock.release();
        this.wakeLock = null;
      }
    } catch { /* not allowed */ }
  }

  command(cmd) {
    const dialog = $('#settings');
    switch (cmd) {
      case 'menu':
        if (this.state === 'playing') this.pause();
        else if (this.state === 'paused') this.resume();
        break;
      case 'back':
        if (dialog.open) this.closeSettings();
        else if (this.state === 'paused') this.resume();
        else if (this.state === 'over') {
          if (!$('#over-entry').hidden) this.skipEntry();
          else this.goHome();
        }
        break;
      case 'activate':
        document.activeElement?.click?.();
        break;
      case 'nav:up': case 'nav:down': case 'nav:left': case 'nav:right':
        this.moveFocus(cmd.slice(4));
        break;
      case 'newGame':
        if (this.state === 'home') this.play();
        else if (this.engine && this.state !== 'boot') this.restart();
        break;
      case 'pause':
        if (this.state === 'playing') this.pause();
        else if (this.state === 'paused') this.resume();
        break;
      case 'fullscreen': this.toggleFullscreen(); break;
      case 'toggleSound':
        this.sfxMuted = !this.sfxMuted;
        this.audio.setMuted({ sfx: this.sfxMuted || !['playing', 'paused', 'over'].includes(this.state) });
        this.toast(this.sfxMuted ? 'Sound effects off' : 'Sound effects on');
        break;
      case 'toggleMusic': {
        const on = !this.settings.get('audio.musicOn');
        this.settings.set('audio.musicOn', on);
        this.toast(on ? 'Music on' : 'Music off');
        break;
      }
      case 'settings':
        if (this.state === 'playing') this.pause();
        this.openSettings();
        break;
      case 'play': this.play(); break;
      case 'resume': this.resume(); break;
      case 'restart': this.restart(); break;
      case 'home': this.goHome(); break;
      case 'again': this.restart(); break;
      case 'data': this.openSettings('game'); break;
      case 'import-folder': $('#pick-folder').click(); break;
      case 'import-zip': $('#pick-files').click(); break;
      default: break;
    }
  }

  focusables() {
    const dialog = $('#settings');
    const root = dialog.open ? dialog : $(`#slot .panel:not([hidden]):not(.leaving)`);
    if (!root) return [];
    const sel = dialog.open ? 'button, input, select, summary, [tabindex="0"]' : '[data-nav], summary, input';
    return $$(sel, root).filter((n) => !n.disabled && n.offsetParent !== null && !n.closest('[hidden]'));
  }

  moveFocus(dir) {
    const list = this.focusables();
    if (!list.length) return;
    const cur = document.activeElement;
    let i = list.indexOf(cur);
    const seg = cur?.closest('.seg');
    if ((dir === 'left' || dir === 'right') && cur?.type === 'range') {
      cur.value = Number(cur.value) + (dir === 'right' ? 5 : -5);
      cur.dispatchEvent(new Event('input', { bubbles: true }));
      cur.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if ((dir === 'left' || dir === 'right') && seg) {
      const btns = $$('button', seg);
      const j = btns.indexOf(cur) + (dir === 'right' ? 1 : -1);
      if (btns[j]) { btns[j].focus(); this.audio.blip('move'); }
      return;
    }
    if (i < 0) i = dir === 'up' ? 0 : -1;
    let next = list[(i + (dir === 'up' || dir === 'left' ? -1 : 1) + list.length) % list.length];
    // Skip sideways through a segmented control as one stop.
    if (seg && next?.closest('.seg') === seg) {
      const btns = $$('button', seg);
      const after = dir === 'up' || dir === 'left' ? list[list.indexOf(btns[0]) - 1] : list[list.indexOf(btns.at(-1)) + 1];
      next = after || next;
    }
    next?.focus();
    this.audio.blip('move');
  }

  async toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        // Lets Esc reach the game (hold Esc to leave full screen).
        await navigator.keyboard?.lock?.(['Escape']).catch(() => {});
      } else {
        await document.exitFullscreen();
      }
    } catch {
      this.toast('Full screen is not available here');
    }
  }

  // ---------------------------------------------------------------------
  // UI wiring

  bindUi() {
    const slot = $('#slot');
    slot.addEventListener('click', (e) => {
      const cmd = e.target.closest('[data-cmd]');
      if (cmd) {
        this.audio.blip('select');
        this.command(cmd.dataset.cmd);
        return;
      }
      const p = e.target.closest('[data-players]');
      if (p) {
        this.settings.set('game.players', Number(p.dataset.players));
        this.audio.blip('move');
        return;
      }
      const t = e.target.closest('[data-table]');
      if (t) {
        const table = this.tables.find((x) => x.id === t.dataset.table);
        if (table && table !== this.table) this.loadTable(table);
        return;
      }
      const sc = e.target.closest('[data-scope]');
      if (sc) {
        this.scoreScope = sc.dataset.scope;
        this.renderHome();
      }
    });

    // Menu hotkeys (gameplay keys are handled by Input).
    window.addEventListener('keydown', (e) => {
      if (this.input.mode !== 'menu' || $('#settings').open || e.ctrlKey || e.metaKey || e.altKey) return;
      const typing = e.target.matches?.('input:not([type=range]), textarea');
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !typing) {
        e.preventDefault();
        this.moveFocus(e.key.slice(5).toLowerCase());
        return;
      }
      if (typing) return;
      const k = e.key.toLowerCase();
      if (this.state === 'home') {
        if (k >= '1' && k <= '4') this.settings.set('game.players', Number(k));
        else if ((k === 'enter' || k === ' ') && !e.target.closest?.('button, summary, input')) { e.preventDefault(); this.play(); }
      } else if (this.state === 'paused') {
        if (k === 'r') this.restart();
        else if (k === 's') this.command('settings');
        else if (k === 'q') this.goHome();
      } else if (this.state === 'over' && $('#over-entry').hidden) {
        if (k === 'enter' && !e.target.closest?.('button')) { e.preventDefault(); this.restart(); }
      }
    });

    $('#over-entry').addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitEntry();
    });

    const stage = $('#stage');
    let cursorTimer = 0;
    stage.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      stage.classList.add('cursor-awake');
      clearTimeout(cursorTimer);
      cursorTimer = setTimeout(() => stage.classList.remove('cursor-awake'), 1500);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.pause();
      this.updateWakeLock();
    });
    window.addEventListener('blur', () => {
      if (this.state === 'playing' && this.settings.get('game.pauseOnBlur')) this.pause();
    });
    document.addEventListener('fullscreenchange', () => {
      const fs = !!document.fullscreenElement;
      for (const b of $$('[data-fullscreen] use')) b.setAttribute('href', fs ? '#i-exit-full' : '#i-full');
      for (const b of $$('[data-fullscreen-label] span')) b.textContent = fs ? 'Leave full screen' : 'Full screen';
      // Leaving full screen usually means Esc was pressed: honour it as "menu".
      if (!fs && this.state === 'playing') this.pause();
    });
    if (!document.fullscreenEnabled) for (const b of $$('[data-cmd="fullscreen"]')) b.hidden = true;

    // Game data import
    for (const id of ['#pick-folder', '#pick-files']) {
      $(id).addEventListener('change', (e) => {
        const files = [...e.target.files];
        e.target.value = '';
        if (files.length) this.importFiles(files);
      });
    }
    let dragDepth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('#dropzone').hidden = false; } });
    window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropzone').hidden = true; } });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      $('#dropzone').hidden = true;
      this.importFiles(await filesFromDrop(e.dataTransfer));
    });

    // Settings dialog
    const dialog = $('#settings');
    dialog.addEventListener('close', () => this.onSettingsClosed());
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) this.closeSettings();
      const tab = e.target.closest('[data-tab]');
      if (tab) this.renderSettings(tab.dataset.tab);
    });
    this.settings.addEventListener('change', (e) => this.onSettingChanged(e.detail.path));

    this.audio.onMusicStatus = (s) => {
      if (s.state === 'loading') this.toast(`Loading music… ${Math.round(s.progress * 100)}%`, 'info', 0, 'music');
      else if (s.state === 'ready') this.toast(`Music ready (${s.bankName})`, 'info', 2200, 'music');
      else this.toast(`Music unavailable: ${s.error}`, 'error', 5000, 'music');
    };
  }

  applySettings() {
    const s = this.settings.data;
    this.renderer.setFilter(s.display.filter);
    this.renderer.setLayoutOptions({ mode: s.display.layout, integer: s.display.integer });
    this.audio.setLevels(s.audio);
    this.input.setKeys(s.controls.keys);
    this.input.mouse = s.controls.mouse;
    this.input.haptics = s.controls.haptics;
    this.input.rumbleOn = s.controls.rumble;
    $('#fps').hidden = !s.display.fps;
    this.renderKeyLegends();
    this.renderPlayers();
  }

  onSettingChanged(path) {
    const s = this.settings.data;
    const top = path.split('.')[0];
    if (path === 'display.filter') this.renderer.setFilter(s.display.filter);
    if (path === 'display.layout' || path === 'display.integer') {
      this.renderer.setLayoutOptions({ mode: s.display.layout, integer: s.display.integer });
    }
    if (path === 'display.fps') $('#fps').hidden = !s.display.fps;
    if (path === 'display.resolution' && this.table?.kind === 'ft') {
      this.toast('Reloading the table at the new resolution');
      this.closeSettings();
      this.loadTable(this.table);
    }
    if (top === 'audio') this.audio.setLevels(s.audio);
    if (path === 'audio.stereo') this.engine?.setSound(true, s.audio.stereo, 8);
    if (path === 'audio.musicOn' && this.engine) {
      this.engine.setMusic(s.audio.musicOn && ['playing', 'paused', 'over'].includes(this.state));
    }
    if (path === 'audio.bank') this.configureMusic();
    if (path === 'game.physics') this.engine?.setPhysicsRate(s.game.physics);
    if (path === 'game.players') {
      this.engine?.setPlayers(s.game.players);
      this.renderPlayers();
    }
    if (path === 'controls.keys') {
      this.input.setKeys(s.controls.keys);
      this.renderKeyLegends();
    }
    if (path === 'controls.mouse') this.input.mouse = s.controls.mouse;
    if (path === 'controls.haptics') this.input.haptics = s.controls.haptics;
    if (path === 'controls.rumble') this.input.rumbleOn = s.controls.rumble;
    if (path === 'controls.touch') this.updateTouch();
    if ($('#settings').open) this.renderSettings(this.settingsTab, { keepFocus: true });
  }

  renderPlayers() {
    const n = this.settings.get('game.players');
    for (const b of $$('#players-seg button')) b.setAttribute('aria-checked', String(Number(b.dataset.players) === n));
  }

  renderTableSeg() {
    const seg = $('#table-seg');
    const byKind = new Map();
    for (const t of this.tables) if (!byKind.has(t.kind)) byKind.set(t.kind, t);
    $('#table-row').hidden = byKind.size < 2;
    seg.replaceChildren(...[...byKind.values()].map((t) => el('button', {
      role: 'radio', 'data-nav': true, 'data-table': t.id,
      'aria-checked': String(this.table?.kind === t.kind),
      text: t.kind === 'ft' ? 'Full Tilt' : 'Windows',
      title: KINDS[t.kind].edition,
    })));
  }

  renderKeyLegends() {
    if (this.touchSeen && !this.keyboardSeen) {
      const rows = [
        ['Tap left', 'Left flipper'], ['Tap right', 'Right flipper'],
        ['Hold Launch', 'Pull the plunger'], ['Tilt', 'Bump the table'],
      ].flatMap(([k, v]) => [el('span', { class: 'caps' }, el('span', { class: 'keycap', text: k })), el('span', { text: v })]);
      $('#home-keys').replaceChildren(...rows.map((n) => n.cloneNode(true)));
      $('#pause-keys').replaceChildren(...rows);
      return;
    }
    const keys = this.settings.get('controls.keys');
    const rows = (withMenu) => [
      ...MENU_KEYS.map((a) => {
        const codes = keys[a] || [];
        const label = { left: 'Left flipper', right: 'Right flipper', plunger: 'Launch', tilt: 'Tilt' }[a];
        return [el('span', { class: 'caps' }, codes.slice(0, 1).map((c) => el('span', { class: 'keycap', text: keyName(c) }))), el('span', { text: label })];
      }),
      withMenu ? [el('span', { class: 'caps' }, el('span', { class: 'keycap', text: 'Esc' })), el('span', { text: 'Menu' })] : [],
    ].flat();
    $('#home-keys').replaceChildren(...rows(true));
    $('#pause-keys').replaceChildren(...rows(false));
  }

  async renderHome() {
    this.renderTableSeg();
    this.renderPlayers();
    if (!this.table) return;
    const kind = this.table.kind;
    const shared = this.scores.serverAvailable && this.scoreScope === 'shared';
    $('#scores-scope').hidden = !this.scores.serverAvailable;
    for (const b of $$('#scores-scope button')) b.classList.toggle('on', b.dataset.scope === (shared ? 'shared' : 'local'));
    const list = (shared ? await this.scores.server(kind, { force: true }) : null) ?? this.scores.local(kind);
    const me = this.settings.get('player.name').trim().toLowerCase();
    const ol = $('#home-scores');
    if (!list.length) {
      ol.replaceChildren(el('li', { class: 'empty', text: 'No scores yet. The first one is yours.' }));
      return;
    }
    ol.replaceChildren(...list.slice(0, 8).map((e, i) => el('li', { class: me && e.name.toLowerCase() === me ? 'me' : '' },
      el('span', { class: 'n', text: String(i + 1) }),
      el('span', { class: 'who', text: e.name }),
      el('span', { class: 'pts', text: formatScore(e.score) }))));
  }

  // ---------------------------------------------------------------------
  // Game over and high scores

  async onGameOver(go) {
    if (this.state !== 'playing') return;
    this.setState('over');
    const players = Math.max(1, go.count);
    const entries = go.scores.slice(0, players).map((score, i) => ({ player: i + 1, score }));
    const sorted = entries.slice().sort((a, b) => b.score - a.score);
    $('#over-sub').textContent = players > 1 ? `Player ${sorted[0].player} wins` : '';
    $('#over-scores').replaceChildren(...sorted.map((e) => el('li', {},
      el('span', { class: 'n', text: players > 1 ? `P${e.player}` : '' }),
      el('span', {}),
      el('span', { class: 'pts', text: formatScore(e.score) }))));
    $('#over-note').textContent = go.eligible ? '' : 'Cheats were used, so this game is not eligible for high scores.';

    this.pendingEntries = [];
    this.lastSaved = null;
    $('#over-board-wrap').hidden = true;
    if (go.eligible) {
      for (const e of sorted) {
        const q = await this.scores.qualifies(this.table.kind, e.score);
        if (q.any) this.pendingEntries.push({ ...e, q, players });
      }
    }
    this.nextEntry();
  }

  nextEntry() {
    const form = $('#over-entry');
    const entry = this.pendingEntries.shift();
    this.currentEntry = entry || null;
    form.hidden = !entry;
    $('#over-actions').hidden = !!entry;
    if (!entry) {
      requestAnimationFrame(() => $('#over-actions [data-cmd="again"]').focus());
      this.syncEngineScores();
      this.renderOverBoard();
      return;
    }
    $('#over-board-wrap').hidden = true;
    const where = [];
    if (entry.q.shared) where.push(`#${entry.q.shared} in the house`);
    if (entry.q.local) where.push(`#${entry.q.local} on this device`);
    $('#over-entry-label').textContent = entry.players > 1 ? `Player ${entry.player}: new high score` : 'New high score';
    $('#over-rank').textContent = `${formatScore(entry.score)}, ${where.join(' and ')}`;
    const input = $('#over-name');
    input.value = this.settings.get('player.name') || (entry.players > 1 ? `Player ${entry.player}` : '');
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }

  async renderOverBoard() {
    if (!this.table) return;
    const { list, shared } = await this.scores.best(this.table.kind);
    const wrap = $('#over-board-wrap');
    wrap.hidden = !list.length;
    $('#over-board-title').textContent = shared ? 'House High Scores' : 'High Scores';
    const fresh = this.lastSaved;
    $('#over-board').replaceChildren(...list.slice(0, 8).map((e, i) => el('li', {
      class: fresh && e.name === fresh.name && e.score === fresh.score ? 'me' : '',
    },
    el('span', { class: 'n', text: String(i + 1) }),
    el('span', { class: 'who', text: e.name }),
    el('span', { class: 'pts', text: formatScore(e.score) }))));
  }

  async submitEntry() {
    const entry = this.currentEntry;
    if (!entry) return;
    const name = $('#over-name').value.trim().replace(/\s+/g, ' ').slice(0, 20);
    if (!name) return;
    if (entry.player === 1 || entry.players === 1) this.settings.set('player.name', name);
    const res = await this.scores.submit(this.table.kind, { name, score: entry.score, players: entry.players });
    this.lastSaved = { name, score: entry.score };
    const rank = res.sharedRank || res.localRank;
    if (rank) this.toast(`Saved: #${rank}${res.sharedRank ? ' in the house' : ''}`);
    this.nextEntry();
  }

  skipEntry() { this.nextEntry(); }

  // ---------------------------------------------------------------------
  // Game data import

  async importFiles(list) {
    try {
      this.toast('Reading files…', 'info', 0, 'import');
      const found = detect(await expandFiles(list));
      if (!found.packs.length && !found.banks.length) {
        this.toast('No PINBALL.DAT or CADET.DAT in those files. Pick the game folder itself.', 'error', 6000, 'import');
        return;
      }
      await importDetected(found, (p) => this.toast(`Importing… ${Math.round(p * 100)}%`, 'info', 0, 'import'));
      navigator.storage?.persist?.().catch(() => {});
      const what = [
        ...found.packs.map((p) => KINDS[p.kind].edition),
        ...found.banks.map((b) => b.name),
      ].join(', ');
      this.toast(`Imported ${what}`, 'info', 3500, 'import');
      const prevKind = this.table?.kind;
      await this.refreshTables();
      if (found.banks.length) this.configureMusic();
      const newKind = found.packs[0]?.kind;
      if (newKind && (!this.engine || newKind !== prevKind)) {
        const t = this.tables.find((x) => x.kind === newKind && x.source === 'local') || this.tables[0];
        if (t) {
          this.closeSettings();
          await this.loadTable(t);
        }
      } else if ($('#settings').open) {
        this.renderSettings(this.settingsTab, { keepFocus: true });
      }
    } catch (err) {
      console.error(err);
      this.toast(`Import failed: ${err.message || err}`, 'error', 6000, 'import');
    }
  }

  // ---------------------------------------------------------------------
  // Settings dialog

  openSettings(tab = 'display') {
    const dialog = $('#settings');
    this.input.setMode('menu');
    this.renderSettings(tab);
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => $(`.tabs [data-tab="${tab}"]`).focus());
  }

  closeSettings() {
    const dialog = $('#settings');
    if (dialog.open) dialog.close();
  }

  onSettingsClosed() {
    if (this.capturing) this.input.setMode('menu');
    this.capturing = null;
    this.input.setMode(this.state === 'playing' ? 'game' : 'menu');
    this.showPanel({ data: 'data', home: 'home', paused: 'pause', over: 'over' }[this.state] || null);
  }

  renderSettings(tab, { keepFocus = false } = {}) {
    this.settingsTab = tab;
    const s = this.settings;
    const focusedPath = keepFocus ? document.activeElement?.dataset?.path : null;
    for (const b of $$('.tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));

    const row = (label, control, help) => el('div', { class: 'set-row' },
      el('span', { class: 'set-label', text: label }),
      el('div', { class: 'control' }, control),
      help ? el('p', { class: 'help', text: help }) : null);
    const seg = (path, options) => el('div', { class: 'seg', role: 'radiogroup' }, options.map(([value, label]) => el('button', {
      type: 'button', role: 'radio', 'data-path': `${path}=${value}`,
      'aria-checked': String(s.get(path) === value),
      onclick: () => s.set(path, value),
      text: label,
    })));
    const toggle = (path, label) => el('label', { class: 'switch' },
      el('input', {
        type: 'checkbox', 'data-path': path, 'aria-label': label, checked: s.get(path),
        onchange: (e) => s.set(path, e.target.checked),
      }),
      el('span'));
    const range = (path, label) => {
      const value = el('span', { class: 'range-value', text: String(Math.round(s.get(path) * 100)) });
      return [el('input', {
        type: 'range', min: 0, max: 100, step: 1, 'data-path': path, 'aria-label': label,
        value: Math.round(s.get(path) * 100),
        oninput: (e) => {
          value.textContent = e.target.value;
          s.data.audio[path.split('.')[1]] = Number(e.target.value) / 100;
          this.audio.setLevels(s.data.audio);
        },
        onchange: (e) => s.set(path, Number(e.target.value) / 100),
      }), value];
    };
    const group = (title, ...rows) => el('section', { class: 'set-group' }, el('h2', { text: title }), ...rows);

    const body = $('#settings-body');
    const st = this.engine?.read();
    let content = [];

    if (tab === 'display') {
      content = [
        group('Picture',
          row('Filter', seg('display.filter', [['sharp', 'Sharp'], ['smooth', 'Smooth'], ['pixel', 'Pixel'], ['crt', 'CRT']]),
            'Sharp keeps pixels crisp at any size. CRT adds scanlines once the table is big enough to show them.'),
          row('Layout', seg('display.layout', [['auto', 'Auto'], ['landscape', 'Side by side'], ['portrait', 'Stacked']]),
            'Stacked puts the score panel under the table: better on phones and portrait monitors.'),
          row('Whole-number scaling', toggle('display.integer', 'Whole-number scaling'), 'Only scale by 2×, 3×… for perfectly even pixels.'),
          this.table?.kind === 'ft'
            ? row('Table resolution', seg('display.resolution', [[-1, 'Highest'], [0, '640×480'], [1, '800×600'], [2, '1024×768']]), 'Full Tilt! ships art for three resolutions.')
            : null),
        group('Overlays',
          row('Tilt meter', toggle('display.tiltMeter', 'Tilt meter'), 'Shows how close your nudging is to a tilt. The line marks the table\'s warning.'),
          row('Frame rate', toggle('display.fps', 'Frame rate'))),
      ];
    } else if (tab === 'sound') {
      const bank = this.pickBank();
      const hasMusic = st?.musicAvailable;
      content = [
        group('Volume',
          row('Master', range('audio.master', 'Master volume')),
          row('Effects', range('audio.sfx', 'Effects volume')),
          row('Music', range('audio.music', 'Music volume'))),
        group('Music',
          row('Play music', toggle('audio.musicOn', 'Play music'),
            hasMusic === false ? 'This table\'s data has no music file (PINBALL.MID or the Full Tilt TABA tracks).' : null),
          row('Instrument sounds', seg('audio.bank', [['auto', 'Auto'], ['bundled', 'Bundled']]),
            bank ? `Playing through ${bank.name}. Auto uses gm.dls (the Windows synth) when it is in your game data.` : 'No sound bank is available, so music is off.')),
        group('Effects',
          row('Stereo positioning', toggle('audio.stereo', 'Stereo positioning'), 'Places each sound left or right of where it happens on the table.')),
      ];
    } else if (tab === 'controls') {
      const keys = s.get('controls.keys');
      const bindRow = (a) => {
        const chips = (keys[a.id] || []).map((code) => el('button', {
          type: 'button', class: 'chip', title: 'Remove', 'aria-label': `Remove ${keyName(code)}`,
          onclick: () => s.set('controls.keys', { ...keys, [a.id]: keys[a.id].filter((c) => c !== code) }),
        }, keyName(code), icon('i-close')));
        const add = el('button', {
          type: 'button', class: 'chip add', text: (keys[a.id] || []).length ? 'Add' : 'Add key',
          onclick: (e) => {
            const btn = e.currentTarget;
            btn.classList.add('capturing');
            btn.textContent = 'Press a key';
            this.capturing = a.id;
            this.input.captureKey((code) => {
              this.capturing = null;
              if (!code) { this.renderSettings('controls', { keepFocus: true }); return; }
              const next = {};
              for (const [k, v] of Object.entries(keys)) next[k] = v.filter((c) => c !== code);
              next[a.id] = [...(next[a.id] || []), code].slice(-3);
              s.set('controls.keys', next);
            });
          },
        });
        return row(a.label, el('div', { class: 'bind-chips' }, chips, add));
      };
      content = [
        group('Keyboard',
          ...ACTIONS.map(bindRow),
          row('Menu', el('span', { class: 'chip', text: 'Esc' }), 'Esc pauses and opens the menu. F2 restarts, F3 pauses, F4 toggles full screen, F5 effects, F6 music, F8 settings.'),
          el('div', { class: 'set-row' }, el('span'), el('div', { class: 'control' },
            el('button', { type: 'button', class: 'btn', text: 'Restore default keys', onclick: () => s.set('controls.keys', structuredClone(DEFAULT_KEYS)) }))),
          el('p', { class: 'note', text: 'Windows tip: pressing Shift five times opens the Sticky Keys prompt. Turn off its shortcut in Settings → Accessibility → Keyboard so it never interrupts a game.' })),
        group('Mouse and touch',
          row('Mouse buttons flip', toggle('controls.mouse', 'Mouse buttons flip'), 'Left and right click work the flippers, middle click launches, side buttons bump the table.'),
          row('Touch controls', seg('controls.touch', [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']]), 'Tap the left or right half of the screen to flip. Hold Launch to pull the plunger.'),
          row('Vibration', toggle('controls.haptics', 'Vibration on touch'))),
        group('Controller',
          row('Rumble', toggle('controls.rumble', 'Controller rumble'), 'Bumpers and triggers flip, A launches, Y or up tilts, the D-pad bumps left and right, Start opens the menu.')),
      ];
    } else if (tab === 'game') {
      const tableItems = this.tables.map((t) => el('li', {},
        el('span', {}, `${KINDS[t.kind].edition} `, el('small', { text: t.source === 'server' ? 'from the server' : 'imported in this browser' })),
        t === this.table ? el('small', { text: 'Loaded' }) : el('button', { type: 'button', class: 'btn', text: 'Load', onclick: () => { this.closeSettings(); this.loadTable(t); } })));
      content = [
        group('Simulation',
          row('Physics rate', seg('game.physics', [[120, '120/s'], [240, '240/s'], [480, '480/s']]),
            'Minimum simulation steps per second. Every displayed frame is split evenly, so motion stays smooth on 60, 120 or 144 Hz screens. The original ran at about 120.'),
          row('Pause when you switch away', toggle('game.pauseOnBlur', 'Pause when you switch away'))),
        group('Game data',
          this.tables.length ? el('ul', { class: 'table-list' }, tableItems) : el('p', { class: 'note', text: 'No table files yet.' }),
          el('div', { class: 'set-row' }, el('span', { class: 'set-label', text: 'Import' }), el('div', { class: 'control' },
            el('button', { type: 'button', class: 'btn', text: 'Choose folder', onclick: () => $('#pick-folder').click() }),
            el('button', { type: 'button', class: 'btn', text: 'Choose a .zip or files', onclick: () => $('#pick-files').click() })),
          el('p', { class: 'help', text: 'Add gm.dls from C:\\Windows\\System32\\drivers to hear the music exactly as Windows played it.' })),
          el('div', { class: 'set-row' }, el('span', { class: 'set-label', text: 'Imported data' }), el('div', { class: 'control' },
            el('button', {
              type: 'button', class: 'btn', text: 'Remove from this browser',
              onclick: async () => {
                await deleteLocalData();
                this.toast('Imported game data removed');
                await this.refreshTables();
                this.renderSettings('game');
              },
            })))),
        group('High scores',
          el('div', { class: 'set-row' }, el('span', { class: 'set-label', text: 'This device' }), el('div', { class: 'control' },
            el('button', {
              type: 'button', class: 'btn', text: 'Clear my scores',
              onclick: () => {
                if (!this.table) return;
                this.scores.clearLocal(this.table.kind);
                this.syncEngineScores();
                this.renderHome();
                this.toast('Scores on this device cleared');
              },
            }))),
          el('p', { class: 'note', text: this.scores.serverAvailable ? 'House scores are shared by everyone using this server.' : 'This server has no shared leaderboard; scores stay on this device.' })),
        group('About',
          el('p', { class: 'credits' },
            'Engine: SpaceCadetPinball by k4zmu2a and contributors (MIT), a decompilation of 3D Pinball for Windows. ',
            'Music synthesis: SpessaSynth (Apache 2.0)',
            BUILD.soundfont ? `, with ${BUILD.soundfontName} by S. Christian Collins.` : '.',
            ' Table, art and sounds © Microsoft, Maxis and Cinematronics; supplied from your own copy. ',
            el('br'),
            `Build ${BUILD.version}${this.engine ? `, engine ${this.engine.version()}` : ''}, ${this.renderer.backend}.`)),
      ];
    }
    body.replaceChildren(...content.filter(Boolean));
    if (focusedPath) body.querySelector(`[data-path="${CSS.escape(focusedPath)}"]`)?.focus();
  }

  // ---------------------------------------------------------------------
  // Messages

  onEngineMessage(flags, title, msg) {
    const isError = (flags & 0x10) !== 0;
    console[isError ? 'error' : 'warn']('[engine]', title, msg);
    if (isError) this.toast(`${title}. ${msg}`, 'error', 7000);
  }

  toast(text, kind = 'info', ms = 2600, key = null) {
    const box = $('#toasts');
    let t = key ? box.querySelector(`[data-key="${key}"]`) : null;
    if (!t) {
      t = el('div', { class: 'toast', 'data-key': key || undefined, role: kind === 'error' ? 'alert' : 'status' });
      box.append(t);
    }
    t.className = `toast ${kind === 'error' ? 'error' : ''}`;
    t.textContent = text;
    clearTimeout(t._timer);
    if (ms > 0) {
      t._timer = setTimeout(() => {
        t.classList.add('out');
        setTimeout(() => t.remove(), 320);
      }, ms);
    }
  }
}

const app = new App();
window.spacecadet = app;
app.start();
