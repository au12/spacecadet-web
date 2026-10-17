// Game data: discovery on the server, in-browser import, and persistence.
//
// The game needs the original data files (PINBALL.DAT + sounds from Windows,
// or CADET.DAT + SOUND/ from Full Tilt! Pinball). They can come from the
// container's /data volume or be imported once in the browser (folder or
// .zip), in which case they are kept in IndexedDB.

import { readZip } from './zip.js';

export const KINDS = {
  '3dpb': { title: 'Space Cadet', edition: '3D Pinball for Windows', marker: 'PINBALL.DAT' },
  ft: { title: 'Space Cadet', edition: 'Full Tilt! Pinball', marker: 'CADET.DAT' },
};
const MARKERS = { 'PINBALL.DAT': '3dpb', 'CADET.DAT': 'ft', 'DEMO.DAT': 'ft' };
const GAME_EXT = /\.(dat|wav|mid|mds)$/i;
const BANK_EXT = /\.(dls|sf2|sf3)$/i;

// --- IndexedDB ------------------------------------------------------------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('spacecadet', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('packs')) db.createObjectStore('packs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('banks')) db.createObjectStore('banks', { keyPath: 'name' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => { db.close(); resolve(result); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  });
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// --- detection ----------------------------------------------------------

const norm = (p) => p.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^[A-Za-z]:\//, '');
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const base = (p) => p.slice(p.lastIndexOf('/') + 1);

/**
 * Finds table data sets and sound banks in a flat list of files.
 * @param {{path:string,size:number,read:()=>Promise<Uint8Array>}[]} files
 */
export function detect(files) {
  const list = files.map((f) => ({ ...f, path: norm(f.path) }));
  const roots = new Map();
  for (const f of list) {
    const kind = MARKERS[base(f.path).toUpperCase()];
    if (kind && f.size > 1000) {
      const root = dirOf(f.path);
      // Prefer the real table over the Full Tilt demo if both are present.
      if (!roots.has(root) || base(f.path).toUpperCase() !== 'DEMO.DAT') roots.set(root, kind);
    }
  }
  const packs = [];
  for (const [root, kind] of roots) {
    const members = list.filter((f) => {
      if (!f.path.startsWith(root) || !GAME_EXT.test(f.path)) return false;
      const rel = f.path.slice(root.length);
      // Direct children, plus Full Tilt's SOUND/ folder.
      return !rel.includes('/') || /^sound\/[^/]+$/i.test(rel);
    });
    packs.push({
      kind,
      root,
      name: root.replace(/\/$/, '').split('/').pop() || KINDS[kind].edition,
      files: members.map((f) => ({ rel: f.path.slice(root.length), size: f.size, read: f.read })),
    });
  }
  const banks = list.filter((f) => BANK_EXT.test(f.path) && f.size > 100000)
    .map((f) => ({ name: base(f.path), size: f.size, read: f.read }));
  return { packs, banks };
}

/** Expands dropped/picked files (zips are opened) into a flat list. */
export async function expandFiles(fileList) {
  const out = [];
  for (const item of fileList) {
    const file = item.file || item;
    const path = item.path || file.webkitRelativePath || file.name;
    if (/\.zip$/i.test(file.name)) {
      const entries = await readZip(file);
      const prefix = dirOf(path);
      for (const e of entries) out.push({ path: prefix + e.path, size: e.size, read: e.read });
    } else {
      out.push({ path, size: file.size, read: async () => new Uint8Array(await file.arrayBuffer()) });
    }
  }
  return out;
}

/** Walks a DataTransfer (drag and drop), including dropped folders. */
export async function filesFromDrop(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files];
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, prefix + entry.name + '/');
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

/** Stores detected packs and banks in IndexedDB. */
export async function importDetected({ packs, banks }, onProgress) {
  const total = packs.reduce((n, p) => n + p.files.length, 0) + banks.length;
  let done = 0;
  const saved = [];
  for (const pack of packs) {
    const files = [];
    for (const f of pack.files) {
      files.push({ rel: f.rel, size: f.size, blob: new Blob([await f.read()]) });
      onProgress?.(++done / total);
    }
    const id = `${pack.kind}-${Date.now().toString(36)}`;
    const record = { id, kind: pack.kind, name: pack.name, files, importedAt: Date.now() };
    // One imported copy per edition is enough; replace older imports.
    const existing = (await listLocalPacks()).filter((p) => p.kind === pack.kind);
    await tx('packs', 'readwrite', (s) => {
      for (const e of existing) s.delete(e.id);
      s.put(record);
    });
    saved.push(record);
  }
  for (const b of banks) {
    const blob = new Blob([await b.read()]);
    await tx('banks', 'readwrite', (s) => s.put({ name: b.name, blob }));
    onProgress?.(++done / total);
  }
  return saved;
}

export async function listLocalPacks() {
  try {
    return await tx('packs', 'readonly', (s) => reqP(s.getAll()));
  } catch {
    return [];
  }
}

export async function listLocalBanks() {
  try {
    return await tx('banks', 'readonly', (s) => reqP(s.getAll()));
  } catch {
    return [];
  }
}

export async function deleteLocalData() {
  await tx('packs', 'readwrite', (s) => s.clear());
  await tx('banks', 'readwrite', (s) => s.clear());
}

// --- sources --------------------------------------------------------------

async function fetchServer() {
  try {
    const res = await fetch('api/tables', { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Fetches with bounded concurrency, reporting byte progress. */
async function fetchAll(items, onProgress, limit = 6) {
  const total = items.reduce((n, i) => n + (i.size || 1), 0);
  let loaded = 0;
  const out = new Map();
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      const res = await fetch(item.url);
      if (!res.ok) throw new Error(`Could not download ${item.rel} (${res.status})`);
      out.set(item.rel, new Uint8Array(await res.arrayBuffer()));
      loaded += item.size || 1;
      onProgress?.(loaded / total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Lists every playable table from the server and the browser.
 * @returns {Promise<{tables:object[], banks:object[], server:object|null}>}
 */
export async function discover() {
  const [server, localPacks, localBanks] = await Promise.all([fetchServer(), listLocalPacks(), listLocalBanks()]);
  const tables = [];
  for (const t of server?.tables || []) {
    tables.push({
      id: 'server:' + t.id,
      kind: t.kind,
      source: 'server',
      name: t.name,
      size: t.files.reduce((n, f) => n + f.size, 0),
      load: (onProgress) => fetchAll(t.files.map((f) => ({ rel: f.path, size: f.size, url: f.url })), onProgress),
    });
  }
  for (const p of localPacks) {
    tables.push({
      id: 'local:' + p.id,
      kind: p.kind,
      source: 'local',
      name: p.name,
      size: p.files.reduce((n, f) => n + f.size, 0),
      load: async (onProgress) => {
        const out = new Map();
        let i = 0;
        for (const f of p.files) {
          out.set(f.rel, new Uint8Array(await f.blob.arrayBuffer()));
          onProgress?.(++i / p.files.length);
        }
        return out;
      },
    });
  }
  // The original Windows table first, server copies before imported ones.
  tables.sort((a, b) => (a.kind === b.kind ? (a.source === 'server' ? -1 : 1) : a.kind === '3dpb' ? -1 : 1));

  const banks = [];
  for (const b of server?.banks || []) banks.push({ name: b.name, url: b.url, source: 'server' });
  for (const b of localBanks) banks.push({ name: b.name, url: URL.createObjectURL(b.blob), source: 'local' });
  return { tables, banks, server };
}
