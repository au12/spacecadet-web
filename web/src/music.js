// MIDI music through SpessaSynth (SoundFont/DLS synthesizer in an AudioWorklet).
// Loaded on demand by audio.js the first time the table asks for music.

import { WorkletSynthesizer, Sequencer } from 'spessasynth_lib';

/* global __PROCESSOR__ */
// The AudioWorklet processor is copied next to this chunk by build.mjs.
const PROCESSOR_URL = new URL(__PROCESSOR__, import.meta.url);

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sound bank download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return res.arrayBuffer();
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  let got = 0;
  for (;;) {
    // Every byte is here: don't wait on the stream's end-of-body signal,
    // which some proxies and browsers deliver late or not at all.
    if (got === total) {
      reader.cancel().catch(() => {});
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > out.length) {
      // Content-Length was the compressed size; fall back to concatenation.
      const chunks = [out.subarray(0, got), value];
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        chunks.push(r.value);
      }
      return new Blob(chunks).arrayBuffer();
    }
    out.set(value, got);
    got += value.length;
    onProgress?.(got / total);
  }
  return out.buffer;
}

const LOAD_TIMEOUT_MS = 30000;
const WORKLET_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 120000;
let workletReady = null;

function withTimeout(promise, ms, message) {
  let timer = 0;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Turns a synthesizer error into one short sentence for the player. */
function reasonOf(err) {
  const text = String(err?.message || err || 'unknown error');
  return text.replace(/\s*The file may be corrupted\.?\s*$/i, '').replace(/^Error:\s*/, '');
}

export class MusicPlayer {
  /**
   * Downloads a sound bank and starts a synthesizer with it.
   * Rejects (never hangs) when the bank can't be used: SpessaSynth reports
   * parse failures as a `soundBankError` event and leaves addSoundBank()
   * pending forever, so that event and a timeout are raced against it.
   */
  static async create(ctx, destination, bankUrl, { onProgress, onStage } = {}) {
    const t0 = performance.now();
    const ms = () => `${Math.round(performance.now() - t0)} ms`;
    // The synthesizer's audio-thread code loads once per page.
    workletReady ??= withTimeout(
      ctx.audioWorklet.addModule(PROCESSOR_URL.href),
      WORKLET_TIMEOUT_MS,
      `this browser didn't start the music engine (AudioWorklet, audio state "${ctx.state}")`,
    ).then(() => console.info(`Music: synthesizer code loaded after ${ms()}`))
      .catch((err) => { workletReady = null; err.stage = 'worklet'; throw err; });
    const [bank] = await Promise.all([
      withTimeout(fetchWithProgress(bankUrl, onProgress), DOWNLOAD_TIMEOUT_MS, 'the sound bank download stalled'),
      workletReady,
    ]);
    console.info(`Music: ${bank.byteLength} byte sound bank downloaded after ${ms()}`);
    onStage?.('instruments');

    const synth = new WorkletSynthesizer(ctx);
    let timer = 0;
    const failure = new Promise((_, reject) => {
      synth.eventHandler.addEvent('soundBankError', 'spacecadet-load', (err) => reject(new Error(reasonOf(err))));
      timer = setTimeout(() => reject(new Error('the synthesizer did not respond')), LOAD_TIMEOUT_MS);
    });
    try {
      await Promise.race([
        (async () => {
          await synth.soundBankManager.addSoundBank(bank, 'main');
          await synth.isReady;
        })(),
        failure,
      ]);
    } catch (err) {
      try { synth.destroy?.(); } catch { /* already gone */ }
      const e = new Error(reasonOf(err));
      e.stage = 'bank';
      throw e;
    } finally {
      clearTimeout(timer);
      synth.eventHandler.removeEvent('soundBankError', 'spacecadet-load');
    }
    synth.connect(destination);
    console.info(`Music: instruments ready after ${ms()}`);
    return new MusicPlayer(synth);
  }

  constructor(synth) {
    this.synth = synth;
    this.seq = new Sequencer(synth, { skipToFirstNoteOn: false });
  }

  play(midiBuffer) {
    // The buffer is transferred to the worklet, so hand over a copy.
    this.seq.loadNewSongList([{ binary: midiBuffer.slice(0), fileName: 'table.mid' }]);
    this.seq.loopCount = -1;
    this.seq.play();
  }

  stop() {
    this.seq.pause();
    this.synth.stopAll(true);
  }

  destroy() {
    try {
      this.stop();
      this.synth.destroy?.();
    } catch { /* already gone */ }
  }
}
