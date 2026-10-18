// Production build: bundles the front end, fingerprints every asset so it can
// be cached forever, writes the service worker's precache list, and stores
// Brotli + gzip variants next to each file for the server to hand out.
//
// Inputs (env):
//   ENGINE_DIR      directory with pinball.mjs + pinball.wasm  (default ./engine-dist)
//   SOUNDFONT_FILE  path to a .sf2/.sf3 to bundle for music    (optional)
//   SOUNDFONT_URL   URL to download one from instead           (optional)
//   SOUNDFONT_NAME  display name                               (default "GeneralUser GS")
//   SOUNDFONT_SF3   "0" keeps an .sf2 as is instead of compressing it to .sf3

import { build, context } from 'esbuild';
import { createHash } from 'node:crypto';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, 'src');
const pub = path.join(root, 'public');
const out = path.join(root, 'dist');
const assets = path.join(out, 'assets');
const engineDir = path.resolve(root, process.env.ENGINE_DIR || 'engine-dist');
const watch = process.argv.includes('--watch');

const hashOf = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 10);

async function hashFile(file) {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex').slice(0, 10);
}

async function fingerprintCopy(from, name) {
  const ext = path.extname(name);
  const hashed = `${path.basename(name, ext)}-${await hashFile(from)}${ext}`;
  await fs.copyFile(from, path.join(assets, hashed));
  return `assets/${hashed}`;
}

async function soundfont() {
  const name = process.env.SOUNDFONT_NAME || 'GeneralUser GS';
  let file = process.env.SOUNDFONT_FILE;
  const url = process.env.SOUNDFONT_URL;
  if (!file && url) {
    file = path.join(root, '.cache', path.basename(new URL(url).pathname) || 'soundfont.sf2');
    try {
      await fs.access(file);
    } catch {
      console.log(`Downloading sound bank ${url}`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`Sound bank download failed: ${res.status}`);
      await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
    }
  }
  if (!file) return null;
  if (/\.sf2$/i.test(file) && process.env.SOUNDFONT_SF3 !== '0') {
    // Vorbis-compressed samples: about a quarter of the download.
    const sf3 = path.join(root, '.cache', `${path.basename(file, path.extname(file))}-${await hashFile(file)}.sf3`);
    try {
      await fs.access(sf3);
    } catch {
      console.log('Compressing the sound bank to SF3…');
      await fs.mkdir(path.dirname(sf3), { recursive: true });
      const { convertToSf3 } = await import('./tools/sf3.mjs');
      const { before, after } = await convertToSf3(file, sf3 + '.tmp');
      await fs.rename(sf3 + '.tmp', sf3);
      console.log(`Sound bank: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB`);
    }
    file = sf3;
  }
  const ext = path.extname(file) || '.sf2';
  return { url: await fingerprintCopy(file, `soundbank${ext}`), name };
}

async function compress(dir) {
  const compressible = /\.(html|js|mjs|css|wasm|json|webmanifest|svg|sf2|sf3|dls|txt|map)$/i;
  const files = [];
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (compressible.test(e.name) && !e.name.endsWith('.map')) files.push(p);
    }
  };
  await walk(dir);
  await Promise.all(files.map(async (f) => {
    const data = await fs.readFile(f);
    if (data.length < 1024) return;
    const big = data.length > 4 * 1024 * 1024;
    const br = zlib.brotliCompressSync(data, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: big ? 9 : 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
        [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
      },
    });
    const gz = zlib.gzipSync(data, { level: 9 });
    // Big files must earn their extra copies on disk.
    const keep = big ? 0.8 : 0.95;
    if (br.length < data.length * keep) await fs.writeFile(f + '.br', br);
    if (gz.length < data.length * keep) await fs.writeFile(f + '.gz', gz);
  }));
}

async function main() {
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(assets, { recursive: true });

  for (const f of ['pinball.mjs', 'pinball.wasm']) {
    await fs.access(path.join(engineDir, f)).catch(() => {
      throw new Error(`Missing ${f} in ${engineDir}; build the engine first (see README).`);
    });
  }
  const engineWasm = await fingerprintCopy(path.join(engineDir, 'pinball.wasm'), 'pinball.wasm');
  const engineModule = await fingerprintCopy(path.join(engineDir, 'pinball.mjs'), 'pinball.mjs');
  const processor = await fingerprintCopy(
    path.join(root, 'node_modules/spessasynth_lib/dist/spessasynth_processor.min.js'),
    'spessasynth_processor.js',
  );
  const bank = await soundfont();

  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const buildInfo = {
    version: pkg.version,
    engineModule,
    engineWasm,
    soundfont: bank?.url || null,
    soundfontName: bank?.name || null,
  };

  const options = {
    entryPoints: { app: path.join(src, 'app.js') },
    bundle: true,
    splitting: true,
    format: 'esm',
    target: ['es2022', 'chrome100', 'firefox110', 'safari16'],
    minify: !watch,
    sourcemap: false,
    legalComments: 'linked',
    outdir: assets,
    entryNames: '[name]-[hash]',
    chunkNames: '[name]-[hash]',
    assetNames: '[name]-[hash]',
    metafile: true,
    loader: { '.woff2': 'file', '.woff': 'file' },
    define: {
      __BUILD__: JSON.stringify(buildInfo),
      __PROCESSOR__: JSON.stringify(path.basename(processor)),
    },
    logLevel: 'info',
  };

  const finish = async (result) => {
    const outputs = Object.keys(result.metafile.outputs);
    const rel = (p) => path.relative(out, path.resolve(root, p)).split(path.sep).join('/');
    const entry = outputs.find((o) => result.metafile.outputs[o].entryPoint?.endsWith('app.js'));
    const css = outputs.find((o) => o.endsWith('.css'));
    const appJs = rel(entry);
    const appCss = css ? rel(css) : null;

    // Static files
    await fs.cp(pub, out, { recursive: true });
    const licenses = {
      'PixelifySans-OFL.txt': 'node_modules/@fontsource-variable/pixelify-sans/LICENSE',
      'ChakraPetch-OFL.txt': 'node_modules/@fontsource/chakra-petch/LICENSE',
      'SpessaSynth-Apache-2.0.txt': 'node_modules/spessasynth_lib/LICENSE',
      'spessasynth_core-Apache-2.0.txt': 'node_modules/spessasynth_core/LICENSE',
    };
    await fs.mkdir(path.join(out, 'licenses'), { recursive: true });
    for (const [name, from] of Object.entries(licenses)) {
      await fs.copyFile(path.join(root, from), path.join(out, 'licenses', name)).catch(() => {});
    }

    let html = await fs.readFile(path.join(src, 'index.html'), 'utf8');
    html = html
      .replace('<!--build:head-->', [
        appCss && `<link rel="stylesheet" href="${appCss}">`,
        `<link rel="modulepreload" href="${appJs}">`,
        `<link rel="preload" href="${engineWasm}" as="fetch" type="application/wasm" crossorigin>`,
      ].filter(Boolean).join('\n  '))
      .replace('<!--build:body-->', `<script type="module" src="${appJs}"></script>`);
    await fs.writeFile(path.join(out, 'index.html'), html);

    const assetFiles = (await fs.readdir(assets))
      .filter((f) => !/\.(map|br|gz|txt|woff)$/.test(f) && !/^soundbank-/.test(f) && !/LEGAL/.test(f))
      .map((f) => `assets/${f}`);
    const precache = ['./', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', ...assetFiles];
    const version = hashOf(precache.join('\n') + html);
    const sw = (await fs.readFile(path.join(src, 'sw.js'), 'utf8'))
      .replaceAll("'__VERSION__'", JSON.stringify(version))
      .replaceAll('__PRECACHE__', JSON.stringify(precache));
    if (sw.includes('__VERSION__') || sw.includes('__PRECACHE__')) throw new Error('sw.js placeholders were not filled in');
    await fs.writeFile(path.join(out, 'sw.js'), sw);
    await fs.writeFile(path.join(out, 'build.json'), JSON.stringify({ ...buildInfo, build: version, builtAt: new Date().toISOString() }, null, 2));
    return version;
  };

  if (watch) {
    const ctx = await context({ ...options, plugins: [{ name: 'finish', setup(b) { b.onEnd((r) => r.metafile && finish(r)); } }] });
    await ctx.watch();
    console.log('Watching for changes…');
    return;
  }

  const result = await build(options);
  const version = await finish(result);
  await compress(out);
  const total = (await fs.readdir(assets)).length;
  console.log(`Built ${version}: ${total} asset files${bank ? `, sound bank ${bank.name}` : ', no sound bank (music disabled unless gm.dls is provided)'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
