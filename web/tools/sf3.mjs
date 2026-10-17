// Converts a SoundFont 2 bank to SoundFont 3 (Ogg Vorbis samples), the same
// format MuseScore ships. GeneralUser GS drops from 32 MB to a few MB, so the
// music starts sooner and the image stays small.
//
//   node tools/sf3.mjs input.sf2 output.sf3 [quality 0..10, default 6]

import { readFile, writeFile } from 'node:fs/promises';
import { SoundBankLoader } from 'spessasynth_core';
import { createOggEncoder } from 'wasm-media-encoders';

export async function convertToSf3(input, output, quality = 6) {
  const src = await readFile(input);
  const bank = SoundBankLoader.fromArrayBuffer(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));
  const encoder = await createOggEncoder();

  const encode = async (pcm, sampleRate) => {
    // Each sample becomes its own Ogg stream; configure() resets the encoder.
    encoder.configure({ channels: 1, sampleRate, vbrQuality: quality });
    const parts = [];
    let size = 0;
    for (let i = 0; i < pcm.length; i += 65536) {
      const chunk = encoder.encode([pcm.subarray(i, i + 65536)]);
      if (chunk.length) { parts.push(chunk.slice()); size += chunk.length; }
    }
    const tail = encoder.finalize();
    parts.push(tail.slice());
    size += tail.length;
    const out = new Uint8Array(size);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };

  let last = -1;
  await bank.setSampleFormat({
    format: 'compressed',
    compressionFunction: encode,
    progressFunction: (progress) => {
      const pct = Math.floor(progress * 10) * 10;
      if (pct !== last && Number.isFinite(pct)) { last = pct; process.stdout.write(`  compressing ${pct}%\r`); }
    },
  });
  const sf3 = bank.writeSF2({ software: 'spacecadet-web' });
  await writeFile(output, new Uint8Array(sf3));
  process.stdout.write('\n');
  return { before: src.length, after: sf3.byteLength };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, output, q] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: node tools/sf3.mjs input.sf2 output.sf3 [quality]');
    process.exit(2);
  }
  const t0 = Date.now();
  const { before, after } = await convertToSf3(input, output, q ? Number(q) : 6);
  console.log(`${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
