// Minimal ZIP reader (stored + deflate) built on DecompressionStream.

export async function readZip(blob) {
  const size = blob.size;
  const tailLen = Math.min(size, 65557);
  const tail = new DataView(await blob.slice(size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  const cd = new DataView(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const decoder = new TextDecoder();
  const entries = [];
  for (let i = 0, o = 0; i < count && o + 46 <= cd.byteLength; i++) {
    if (cd.getUint32(o, true) !== 0x02014b50) break;
    const flags = cd.getUint16(o + 8, true);
    const method = cd.getUint16(o + 10, true);
    const compSize = cd.getUint32(o + 20, true);
    const rawSize = cd.getUint32(o + 24, true);
    const nameLen = cd.getUint16(o + 28, true);
    const extraLen = cd.getUint16(o + 30, true);
    const commentLen = cd.getUint16(o + 32, true);
    const local = cd.getUint32(o + 42, true);
    const nameBytes = new Uint8Array(cd.buffer, cd.byteOffset + o + 46, nameLen);
    // Bit 11: UTF-8 names; otherwise CP437, which is ASCII for these files.
    const path = (flags & 0x800 ? decoder.decode(nameBytes) : String.fromCharCode(...nameBytes)).replace(/\\/g, '/');
    o += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith('/')) continue;
    entries.push({
      path,
      size: rawSize,
      async read() {
        const head = new DataView(await blob.slice(local, local + 30).arrayBuffer());
        const start = local + 30 + head.getUint16(26, true) + head.getUint16(28, true);
        const data = blob.slice(start, start + compSize);
        if (method === 0) return new Uint8Array(await data.arrayBuffer());
        if (method !== 8) throw new Error(`Unsupported compression in ${path}`);
        const stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      },
    });
  }
  return entries;
}
