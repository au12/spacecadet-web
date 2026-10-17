// Persistent user settings (localStorage), with defaults and change events.

export const ACTIONS = [
  { id: 'left', label: 'Left flipper' },
  { id: 'right', label: 'Right flipper' },
  { id: 'plunger', label: 'Launch ball' },
  { id: 'tilt', label: 'Tilt (bump from below)' },
  { id: 'bumpLeft', label: 'Bump left' },
  { id: 'bumpRight', label: 'Bump right' },
];

export const DEFAULT_KEYS = {
  left: ['ShiftLeft', 'KeyZ'],
  right: ['ShiftRight', 'Slash'],
  plunger: ['Space', 'ArrowDown'],
  tilt: ['KeyT', 'ArrowUp'],
  bumpLeft: ['KeyX', 'ArrowLeft'],
  bumpRight: ['Period', 'ArrowRight'],
};

const DEFAULTS = {
  version: 1,
  display: {
    filter: 'sharp',      // sharp | smooth | pixel | crt
    layout: 'auto',       // auto | landscape | portrait
    integer: false,
    fps: false,
    tiltMeter: true,
    resolution: -1,       // Full Tilt only: -1 = highest, 0..2
  },
  audio: {
    master: 0.8,
    sfx: 1,
    music: 0.55,
    musicOn: true,
    stereo: true,
    bank: 'auto',         // auto (prefer gm.dls from game data) | bundled
  },
  game: {
    players: 1,
    physics: 240,         // simulation steps per second (minimum)
    table: '',
    pauseOnBlur: true,
  },
  controls: {
    keys: DEFAULT_KEYS,
    mouse: true,
    touch: 'auto',        // auto | on | off
    haptics: true,
    rumble: true,
  },
  player: {
    name: '',
  },
};

const KEY = 'spacecadet.settings';

function merge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over.slice() : base.slice();
  if (base && typeof base === 'object') {
    const out = {};
    for (const k of Object.keys(base)) out[k] = merge(base[k], over?.[k]);
    return out;
  }
  return over === undefined || typeof over !== typeof base ? base : over;
}

export class Settings extends EventTarget {
  constructor() {
    super();
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* private mode */ }
    this.data = merge(DEFAULTS, stored);
  }

  get(path) {
    return path.split('.').reduce((o, k) => o?.[k], this.data);
  }

  set(path, value) {
    const keys = path.split('.');
    let o = this.data;
    for (const k of keys.slice(0, -1)) o = o[k];
    const last = keys.at(-1);
    if (JSON.stringify(o[last]) === JSON.stringify(value)) return;
    o[last] = value;
    this.save();
    this.dispatchEvent(new CustomEvent('change', { detail: { path, value } }));
  }

  reset(path) {
    this.set(path, structuredClone(path.split('.').reduce((o, k) => o?.[k], DEFAULTS)));
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* quota */ }
  }
}
