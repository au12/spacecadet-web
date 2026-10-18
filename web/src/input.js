// Keyboard, mouse, gamepad and touch input mapped to game actions.
//
// Every physical source (a key, a mouse button, a finger, a pad button) is
// tracked separately; an action is held while any of its sources is held, so
// e.g. Left Shift and a controller bumper can both work the left flipper
// without fighting each other.

const COMMAND_KEYS = {
  F2: 'newGame',
  F3: 'pause',
  F4: 'fullscreen',
  F5: 'toggleSound',
  F6: 'toggleMusic',
  F8: 'settings',
};

// Keys whose default browser behaviour must never fire during play.
const SWALLOW = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Slash', 'Quote', 'Backspace']);

const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const PAD_ACTIONS = [
  [PAD.LB, 'left'], [PAD.LT, 'left'],
  [PAD.RB, 'right'], [PAD.RT, 'right'],
  [PAD.A, 'plunger'], [PAD.DOWN, 'plunger'],
  [PAD.Y, 'tilt'], [PAD.UP, 'tilt'],
  [PAD.LEFT, 'bumpLeft'], [PAD.RIGHT, 'bumpRight'],
];

export const KEY_NAMES = {
  ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt', AltRight: 'Right Alt', MetaLeft: 'Left ⌘', MetaRight: 'Right ⌘',
  Space: 'Space', Enter: 'Enter', Escape: 'Esc', Backspace: 'Backspace', Tab: 'Tab',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Slash: '/', Backslash: '\\', Period: '.', Comma: ',', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`',
  NumpadEnter: 'Num Enter', CapsLock: 'Caps Lock',
};

export function keyName(code) {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}

export class Input {
  /**
   * @param {object} h
   * @param {(action:string, down:boolean)=>void} h.onAction
   * @param {(cmd:string)=>void} h.onCommand
   * @param {(ch:number, down:boolean)=>void} h.onChar  raw key for cheat codes
   * @param {(kind:string)=>void} [h.onDevice]          'touch' | 'gamepad' | 'keyboard'
   */
  constructor(stage, h) {
    this.stage = stage;
    this.h = h;
    this.mode = 'off';            // off | game | menu | capture
    this.held = new Map();        // action -> Set(source)
    this.keyMap = new Map();      // code -> action
    this.mouse = true;
    this.haptics = true;
    this.rumbleOn = true;
    this.padState = [];
    this.padMenu = { held: new Set(), repeatAt: 0 };
    this.captureCb = null;
    this._bind();
  }

  setKeys(keys) {
    this.keyMap.clear();
    for (const [action, codes] of Object.entries(keys)) {
      for (const code of codes) this.keyMap.set(code, action);
    }
  }

  setMode(mode) {
    if (mode === this.mode) return;
    if (this.mode === 'game') this.releaseAll();
    this.mode = mode;
  }

  /** Captures the next key press (for rebinding). */
  captureKey(cb) {
    this.prevMode = this.mode;
    this.mode = 'capture';
    this.captureCb = cb;
  }

  isHeld(action) { return (this.held.get(action)?.size || 0) > 0; }

  _press(action, source) {
    let set = this.held.get(action);
    if (!set) this.held.set(action, (set = new Set()));
    if (set.has(source)) return;
    set.add(source);
    if (set.size === 1) this.h.onAction(action, true);
  }

  _release(action, source) {
    const set = this.held.get(action);
    if (!set || !set.delete(source)) return;
    if (set.size === 0) this.h.onAction(action, false);
  }

  _releaseSource(prefix) {
    for (const [action, set] of this.held) {
      for (const s of [...set]) if (s.startsWith(prefix)) this._release(action, s);
    }
  }

  releaseAll() {
    for (const [action, set] of this.held) {
      if (set.size) {
        set.clear();
        this.h.onAction(action, false);
      }
    }
  }

  _bind() {
    window.addEventListener('keydown', (e) => this._key(e, true), { capture: true });
    window.addEventListener('keyup', (e) => this._key(e, false), { capture: true });
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });

    const st = this.stage;
    st.addEventListener('contextmenu', (e) => { if (this.mode === 'game') e.preventDefault(); });
    st.addEventListener('pointerdown', (e) => this._pointer(e, true));
    st.addEventListener('pointerup', (e) => this._pointer(e, false));
    st.addEventListener('pointercancel', (e) => this._pointer(e, false));
    // Stop the mouse back/forward buttons from navigating away mid-game.
    for (const ev of ['mouseup', 'auxclick']) {
      st.addEventListener(ev, (e) => { if (this.mode === 'game' && e.button >= 3) e.preventDefault(); });
    }
    window.addEventListener('gamepadconnected', (e) => this.h.onDevice?.('gamepad', e.gamepad));
  }

  _key(e, down) {
    if (this.mode === 'capture') {
      if (!down) return;
      e.preventDefault();
      e.stopPropagation();
      const cb = this.captureCb;
      this.mode = this.prevMode || 'menu';
      this.captureCb = null;
      cb?.(e.code === 'Escape' ? null : e.code);
      return;
    }

    // On-screen keyboards (typing a name on a phone) don't count as a
    // keyboard player: they report keyCode 229 or an "Unidentified" key.
    if (down && !e.isComposing && e.keyCode !== 229 && e.key !== 'Unidentified' && e.key !== 'Process'
      && !e.target?.closest?.('input, textarea, [contenteditable]')) {
      this.h.onDevice?.('keyboard');
    }

    // Windows can drop the keyup of one Shift while the other is held. Any
    // event that reports Shift as up releases both, so a flipper never sticks.
    if (!e.getModifierState?.('Shift')) {
      this._releaseSource('kb:ShiftLeft');
      this._releaseSource('kb:ShiftRight');
    }

    if (this.mode !== 'game') {
      if (down && e.code === 'Escape') {
        e.preventDefault();
        this.h.onCommand('back');
      } else if (down && COMMAND_KEYS[e.code] && this.mode === 'menu') {
        e.preventDefault();
        this.h.onCommand(COMMAND_KEYS[e.code]);
      }
      return;
    }

    if (e.code === 'Escape') {
      e.preventDefault();
      if (down && !e.repeat) this.h.onCommand('menu');
      return;
    }
    if (COMMAND_KEYS[e.code]) {
      e.preventDefault();
      if (down && !e.repeat) this.h.onCommand(COMMAND_KEYS[e.code]);
      return;
    }
    // Leave browser shortcuts alone.
    if (e.ctrlKey || e.metaKey || (e.altKey && !this.keyMap.has(e.code))) return;

    const action = this.keyMap.get(e.code);
    if (action || SWALLOW.has(e.code)) e.preventDefault();
    if (action && !(down && e.repeat)) {
      if (down) this._press(action, 'kb:' + e.code);
      else this._release(action, 'kb:' + e.code);
    }
    // The table's cheat codes ("hidden test", "rmax"...) read raw characters.
    if (!e.repeat && e.key.length === 1) {
      const ch = e.key.toLowerCase().charCodeAt(0);
      if ((ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57) || ch === 32) this.h.onChar(ch, down);
    }
  }

  _pointer(e, down) {
    if (this.mode !== 'game') return;
    if (e.pointerType === 'touch') return; // handled by the touch layer
    if (!this.mouse || e.target.closest('button, a, input, [data-ui]')) return;
    const map = { 0: 'left', 2: 'right', 1: 'plunger', 3: 'bumpLeft', 4: 'bumpRight' };
    const action = map[e.button];
    if (!action) return;
    e.preventDefault();
    const src = 'mouse:' + e.button;
    if (down) {
      this.stage.setPointerCapture?.(e.pointerId);
      this._press(action, src);
    } else {
      this._release(action, src);
    }
  }

  // --- touch -------------------------------------------------------------

  /** Wires the on-screen touch layer (see index.html #touch). */
  attachTouch(layer) {
    const fingers = new Map();
    const zoneAction = (x) => (x < window.innerWidth / 2 ? 'left' : 'right');
    const down = (e) => {
      if (e.pointerType !== 'touch' || this.mode !== 'game') return;
      e.preventDefault();
      const btn = e.target.closest('[data-action]');
      const action = btn ? btn.dataset.action : zoneAction(e.clientX);
      if (action === 'menu') {
        this.h.onCommand('menu');
        return;
      }
      fingers.set(e.pointerId, action);
      btn?.classList.add('is-held');
      layer.setPointerCapture?.(e.pointerId);
      this._press(action, 'touch:' + e.pointerId);
      if (this.haptics && navigator.vibrate) navigator.vibrate(action === 'tilt' ? 30 : 8);
      this.h.onDevice?.('touch');
    };
    const up = (e) => {
      const action = fingers.get(e.pointerId);
      if (!action) return;
      fingers.delete(e.pointerId);
      layer.querySelector(`[data-action="${action}"]`)?.classList.remove('is-held');
      this._release(action, 'touch:' + e.pointerId);
    };
    layer.addEventListener('pointerdown', down);
    layer.addEventListener('pointerup', up);
    layer.addEventListener('pointercancel', up);
    layer.addEventListener('contextmenu', (e) => e.preventDefault());
    // Report the first real touch so the layer can show itself.
    window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') this.h.onDevice?.('touch'); }, { passive: true });
  }

  // --- gamepads ----------------------------------------------------------

  /** Polls connected gamepads; call once per animation frame. */
  poll(now) {
    if (!navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      const prev = this.padState[i] || (this.padState[i] = []);
      if (!pad || !pad.connected) {
        if (prev.length) {
          this._releaseSource(`pad:${i}:`);
          prev.length = 0;
        }
        continue;
      }
      const pressed = (b) => {
        const btn = pad.buttons[b];
        if (!btn) return false;
        // Analog triggers: hysteresis avoids chatter around the threshold.
        const v = typeof btn.value === 'number' && (b === PAD.LT || b === PAD.RT) ? btn.value : btn.pressed ? 1 : 0;
        return prev[b] ? v > 0.25 : v > 0.45;
      };
      const now0 = [];
      for (let b = 0; b < Math.max(16, pad.buttons.length); b++) now0[b] = pressed(b);
      // Treat the left stick as a D-pad for menus.
      const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
      const stick = { up: ay < -0.6, down: ay > 0.6, left: ax < -0.6, right: ax > 0.6 };

      if (this.mode === 'game') {
        for (const [b, action] of PAD_ACTIONS) {
          const src = `pad:${i}:${b}`;
          if (now0[b] && !prev[b]) this._press(action, src);
          else if (!now0[b] && prev[b]) this._release(action, src);
        }
        if (now0[PAD.START] && !prev[PAD.START]) this.h.onCommand('menu');
        if (now0[PAD.BACK] && !prev[PAD.BACK]) this.h.onCommand('menu');
      } else if (this.mode === 'menu') {
        this._padMenu(now0, prev, stick, now);
      }
      for (let b = 0; b < now0.length; b++) prev[b] = now0[b];
    }
  }

  _padMenu(cur, prev, stick, now) {
    const edge = (b) => cur[b] && !prev[b];
    if (edge(PAD.A)) this.h.onCommand('activate');
    if (edge(PAD.B) || edge(PAD.BACK)) this.h.onCommand('back');
    if (edge(PAD.START)) this.h.onCommand('back');
    const dirs = {
      up: cur[PAD.UP] || stick.up, down: cur[PAD.DOWN] || stick.down,
      left: cur[PAD.LEFT] || stick.left, right: cur[PAD.RIGHT] || stick.right,
    };
    const m = this.padMenu;
    for (const [dir, on] of Object.entries(dirs)) {
      if (on && !m.held.has(dir)) {
        m.held.add(dir);
        m.repeatAt = now + 380;
        this.h.onCommand('nav:' + dir);
      } else if (on && now >= m.repeatAt) {
        m.repeatAt = now + 110;
        this.h.onCommand('nav:' + dir);
      } else if (!on) {
        m.held.delete(dir);
      }
    }
  }

  rumble(strong, weak, ms) {
    if (!this.rumbleOn || !navigator.getGamepads) return;
    for (const pad of navigator.getGamepads()) {
      const act = pad?.vibrationActuator;
      if (act?.playEffect) {
        act.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
      }
    }
  }

  get hasGamepad() {
    return !!navigator.getGamepads && [...navigator.getGamepads()].some((p) => p && p.connected);
  }
}
