// Read only a bounded sample. Large datasets and gzip archives stay on the user's device.
async function* bytes(stream) {
  const reader = stream.getReader();
  try { while (true) { const { value, done } = await reader.read(); if (done) break; yield value; } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function* tarCollection(stream) {
  const iterator = bytes(stream)[Symbol.asyncIterator]();
  let pending = new Uint8Array(0), scanned = 0;
  async function take(n) {
    if (!pending.length) { const next = await iterator.next(); if (next.done) return null; pending = next.value; }
    const part = pending.subarray(0, n); pending = pending.subarray(part.length);
    scanned += part.length;
    if (scanned > 128 * 1024 * 1024) throw new Error('No bounded TSV sample found in the first 128 MB. Extract the archive and select its collection TSV.');
    return part;
  }
  async function header() {
    const out = new Uint8Array(512); let offset = 0;
    while (offset < 512) { const part = await take(512 - offset); if (!part) { if (!offset) return null; throw new Error('Truncated TAR header.'); } out.set(part, offset); offset += part.length; }
    return out;
  }
  try {
    while (true) {
      const h = await header();
      if (!h || h.every(b => b === 0)) break;
      const field = (a, b) => new TextDecoder().decode(h.subarray(a, b)).replace(/\0.*$/, '').trim();
      const name = field(0, 100), sizeText = field(124, 136);
      if (!/^[0-7]+$/.test(sizeText)) throw new Error('Unsupported TAR format. Extract the collection TSV first.');
      const size = parseInt(sizeText, 8), type = h[156];
      const selected = (type === 0 || type === 48) && (/\.(tsv|txt)$/i.test(name) || /(^|\/)collection$/i.test(name));
      let left = size;
      while (left > 0) {
        const part = await take(left);
        if (!part) throw new Error('Truncated TAR archive.');
        left -= part.length;
        if (selected) yield part;
      }
      if (selected) return;
      let padding = (512 - size % 512) % 512;
      while (padding) { const p = await take(padding); if (!p) throw new Error('Truncated TAR archive.'); padding -= p.length; }
    }
    throw new Error('No TSV collection found in the archive.');
  } finally { await iterator.return?.(); }
}
export async function sampleDataset(file, maxRecords) {
  let stream = file.stream();
  const name = file.name.toLowerCase();
  if (/\.(gz|tgz)$/.test(name)) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Extract the gzip archive first; this browser cannot decompress it.');
    stream = stream.pipeThrough(new DecompressionStream('gzip'));
  }
  const source = /\.(tar\.gz|tgz|tar)$/.test(name) ? tarCollection(stream) : bytes(stream);
  const decoder = new TextDecoder('utf-8', { fatal: true }), rows = [], ids = new Set();
  let pending = '', scanned = 0, sampleBytes = 0;
  const encoder = new TextEncoder();
  function add(line) {
    line = line.replace(/^\uFEFF/, '').replace(/\r$/, '');
    const i = line.indexOf('\t');
    if (i < 1) return false;
    const pid = line.slice(0, i).trim(), passage = line.slice(i + 1).trim();
    if (!passage || ids.has(pid) || (/^(pid|passage_id|id)$/i.test(pid) && /^(passage|text)$/i.test(passage))) return false;
    if (pid.length > 200 || passage.length > 20000) throw new Error('A dataset row exceeds the supported length. Use passage-ranking collection TSV.');
    const row = `${pid}\t${passage}\n`, size = encoder.encode(row).byteLength;
    if (sampleBytes + size > 15 * 1024 * 1024) return true;
    sampleBytes += size; rows.push(row); ids.add(pid);
    return rows.length >= maxRecords;
  }
  for await (const chunk of source) {
    scanned += chunk.byteLength;
    if (scanned > 64 * 1024 * 1024) throw new Error('No bounded sample found in the first 64 MB. Select a smaller UTF-8 passage collection.');
    pending += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (add(line)) return { blob: new Blob(rows, { type: 'text/tab-separated-values' }), count: rows.length };
    }
    if (pending.length > 20210) throw new Error('Dataset row is too long. Select a pid<TAB>passage collection.');
  }
  pending += decoder.decode();
  if (pending) add(pending);
  if (!rows.length) throw new Error('No valid pid<TAB>passage rows were found.');
  return { blob: new Blob(rows, { type: 'text/tab-separated-values' }), count: rows.length };
}
