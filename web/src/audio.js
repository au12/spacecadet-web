// WebAudio backend for the engine's SDL_mixer shim (engine/web/web_mixer.cpp).
//
// Sound effects are decoded once into AudioBuffers and fired as one-shot
// buffer sources; nothing is mixed on the main thread, so a slow frame can
// never make the audio crackle. Music is a MIDI file played through a
// SoundFont synthesizer that runs in an AudioWorklet (see music.js), loaded
// lazily so the game starts instantly.

/** Minimal synchronous WAV (RIFF PCM) parser. Returns null for other formats. */
function parseWav(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let fmt = null, data = null;
  for (let o = 12; o + 8 <= bytes.length;) {
    const id = tag(o), size = v.getUint32(o + 4, true), body = o + 8;
    if (id === 'fmt ') {
      fmt = {
        format: v.getUint16(body, true), channels: v.getUint16(body + 2, true),
        rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      data = { offset: body, size: Math.min(size, bytes.length - body) };
    }
    o = body + size + (size & 1);
  }
  if (!fmt || !data || fmt.format !== 1 || ![8, 16].includes(fmt.bits) || fmt.channels < 1) return null;
  const bps = fmt.bits / 8, frames = Math.floor(data.size / (bps * fmt.channels));
  const ch = [];
  for (let c = 0; c < fmt.channels; c++) ch.push(new Float32Array(frames));
  for (let i = 0, o = data.offset; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++, o += bps) {
      ch[c][i] = fmt.bits === 8 ? (v.getUint8(o) - 128) / 128 : v.getInt16(o, true) / 32768;
    }
  }
  return { rate: fmt.rate, channels: ch, frames };
}

export class AudioEngine {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.sfxBus = ctx.createGain();     // user SFX volume
    this.sfxMute = ctx.createGain();    // muted while on the home screen
    this.sfxBus.connect(this.sfxMute).connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicMute = ctx.createGain();
    this.musicBus.connect(this.musicMute).connect(this.master);

    this.sounds = new Map();
    this.nextSoundId = 1;
    this.voices = new Array(8).fill(null);
    this.engineVolume = 1;

    this.tracks = new Map();
    this.nextTrackId = 1;
    this.currentTrack = 0;
    this.music = null;          // MusicPlayer once loaded
    this.musicLoading = null;
    this.musicWanted = false;
    this.musicConfig = { bankUrl: null, bankName: '', fallbackUrl: null, fallbackName: '' };
    this.musicGen = 0;
    this.musicFailed = false;
    this.musicError = null;   // { bankName, reason } when the chosen bank was rejected
    this.musicBank = null;    // name of the bank actually playing
    this.onMusicStatus = null;

    this._unlock = this._unlock.bind(this);
    for (const ev of ['pointerdown', 'keydown', 'touchend']) {
      window.addEventListener(ev, this._unlock, { capture: true, passive: true });
    }
  }

  _unlock() {
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  get running() { return this.ctx.state === 'running'; }

  // --- user-facing mix -------------------------------------------------------

  setLevels({ master = 0.8, sfx = 1, music = 0.6 }) {
    const t = this.ctx.currentTime;
    // Perceptual (squared) curve for the sliders.
    this.master.gain.setTargetAtTime(master * master, t, 0.015);
    this.sfxBus.gain.setTargetAtTime(sfx * sfx * this.engineVolume, t, 0.015);
    this.musicBus.gain.setTargetAtTime(music * music, t, 0.015);
    this._levels = { master, sfx, music };
  }

  /** Mutes or unmutes effects/music with a short fade (home screen, pause). */
  setMuted({ sfx, music }) {
    const t = this.ctx.currentTime;
    if (sfx !== undefined) this.sfxMute.gain.setTargetAtTime(sfx ? 0 : 1, t, 0.03);
    if (music !== undefined) this.musicMute.gain.setTargetAtTime(music ? 0 : 1, t, 0.12);
  }

  // --- Module.scpAudio: sound effects -------------------------------------

  loadSound(bytes) {
    const wav = parseWav(bytes);
    const id = this.nextSoundId++;
    if (wav) {
      const buf = this.ctx.createBuffer(wav.channels.length, Math.max(1, wav.frames), wav.rate);
      wav.channels.forEach((data, c) => buf.copyToChannel(data, c));
      this.sounds.set(id, buf);
    } else {
      // Compressed or unusual WAV: decode asynchronously; plays once ready.
      this.sounds.set(id, null);
      this.ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
        .then((buf) => this.sounds.set(id, buf))
        .catch(() => this.sounds.delete(id));
    }
    return id;
  }

  freeSound(id) { this.sounds.delete(id); }

  allocateChannels(n) {
    for (let i = n; i < this.voices.length; i++) this._stopVoice(i);
    this.voices.length = n;
    for (let i = 0; i < n; i++) if (this.voices[i] === undefined) this.voices[i] = null;
  }

  setVolume(v) {
    this.engineVolume = v;
    if (this._levels) this.setLevels(this._levels);
  }

  play(channel, id) {
    const buf = this.sounds.get(id);
    if (!buf || !this.running) return -1;
    let ch = channel;
    if (ch < 0) ch = this.voices.indexOf(null);
    if (ch < 0 || ch >= this.voices.length) return -1;
    this._stopVoice(ch);

    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    src.connect(gain);
    if (pan) gain.connect(pan).connect(this.sfxBus); else gain.connect(this.sfxBus);
    const voice = { src, gain, pan };
    src.onended = () => {
      if (this.voices[ch] === voice) this.voices[ch] = null;
      src.disconnect();
      gain.disconnect();
      pan?.disconnect();
    };
    this.voices[ch] = voice;
    src.start();
    return ch;
  }

  /** SDL_mixer positional audio: angle in degrees clockwise from north, distance 0..255. */
  setPosition(ch, angle, distance) {
    const voice = this.voices[ch];
    if (!voice) return;
    const t = this.ctx.currentTime;
    if (voice.pan) voice.pan.pan.setValueAtTime(Math.sin((angle * Math.PI) / 180) * 0.8, t);
    voice.gain.gain.setValueAtTime(1 - (distance / 255) * 0.55, t);
  }

  halt(ch) {
    if (ch < 0) for (let i = 0; i < this.voices.length; i++) this._stopVoice(i);
    else this._stopVoice(ch);
  }

  playing(ch) {
    if (ch >= 0) return this.voices[ch] ? 1 : 0;
    let n = 0;
    for (const v of this.voices) if (v) n++;
    return n;
  }

  _stopVoice(i) {
    const v = this.voices[i];
    if (!v) return;
    this.voices[i] = null;
    try { v.src.stop(); } catch { /* not started */ }
  }

  // --- Module.scpAudio: music ---------------------------------------------

  loadMusic(bytes) {
    const id = this.nextTrackId++;
    this.tracks.set(id, bytes.slice().buffer);
    return id;
  }

  freeMusic(id) { this.tracks.delete(id); }

  playMusic(id) {
    if (!this.tracks.has(id)) return -1;
    this.currentTrack = id;
    this.musicWanted = true;
    this._ensureMusic().then((player) => {
      if (player && this.musicWanted && this.currentTrack === id) player.play(this.tracks.get(id));
    });
    return 0;
  }

  haltMusic() {
    this.musicWanted = false;
    this.music?.stop();
  }

  setMusicVolume() { /* the engine always runs at full volume; the page mixes */ }

  /**
   * Chooses the sound bank used for music; takes effect on the next load.
   * `fallback*` is tried when the chosen bank can't be read (e.g. a gm.dls
   * the synthesizer rejects), so music still plays.
   */
  configureMusic({ bankUrl, bankName, fallbackUrl = null, fallbackName = '' }) {
    const c = this.musicConfig;
    if (bankUrl === c.bankUrl && fallbackUrl === c.fallbackUrl) return;
    this.musicConfig = { bankUrl, bankName, fallbackUrl, fallbackName };
    this.musicGen = (this.musicGen || 0) + 1;
    this.musicFailed = false;
    this.musicError = null;
    this.musicBank = null;
    if (this.music) {
      this.music.destroy();
      this.music = null;
      if (this.musicWanted && this.currentTrack) this.playMusic(this.currentTrack);
    }
  }

  _ensureMusic() {
    if (this.music) return Promise.resolve(this.music);
    if (this.musicLoading) return this.musicLoading;
    const cfg = this.musicConfig;
    if (!cfg.bankUrl || this.musicFailed) return Promise.resolve(null);
    const gen = this.musicGen;
    const status = (s) => this.onMusicStatus?.(s);
    const load = async (url, name) => {
      const { MusicPlayer } = await import('./music.js');
      return MusicPlayer.create(this.ctx, this.musicBus, url, {
        onProgress: (p) => status({ state: 'loading', progress: p, bankName: name }),
        onStage: () => status({ state: 'preparing', bankName: name }),
      });
    };

    this.musicLoading = (async () => {
      let player = null;
      try {
        player = await load(cfg.bankUrl, cfg.bankName);
        this.musicBank = cfg.bankName;
        status({ state: 'ready', bankName: cfg.bankName });
      } catch (err) {
        const reason = String(err?.message || err);
        console.warn(`Music: ${cfg.bankName} could not be used:`, reason);
        this.musicError = { bankName: cfg.bankName, reason };
        if (cfg.fallbackUrl && cfg.fallbackUrl !== cfg.bankUrl) {
          try {
            player = await load(cfg.fallbackUrl, cfg.fallbackName);
            this.musicBank = cfg.fallbackName;
            status({ state: 'ready', bankName: cfg.fallbackName, fallbackFrom: cfg.bankName, error: reason });
          } catch (err2) {
            console.warn(`Music: ${cfg.fallbackName} could not be used either:`, err2);
            status({ state: 'error', bankName: cfg.fallbackName, error: String(err2?.message || err2) });
          }
        } else {
          status({ state: 'error', bankName: cfg.bankName, error: reason });
        }
      }
      this.musicLoading = null;
      if (gen !== this.musicGen) {
        // The bank choice changed while this one loaded; start over.
        player?.destroy();
        return this._ensureMusic();
      }
      this.music = player;
      // Don't retry a bank that failed on every track change.
      if (!player) this.musicFailed = true;
      return player;
    })();
    return this.musicLoading;
  }

  /** Short UI feedback blips, synthesized so they need no assets. */
  blip(kind = 'move') {
    if (!this.running) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    const f = { move: 660, select: 990, back: 440 }[kind] || 660;
    osc.type = 'square';
    osc.frequency.setValueAtTime(f, t);
    if (kind === 'select') osc.frequency.setValueAtTime(f * 1.5, t + 0.04);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'select' ? 0.1 : 0.05));
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.12);
  }
}
