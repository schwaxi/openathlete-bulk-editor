// Minimaler ZIP-Leser (ohne Zusatzpakete), auch für Dateien über 4 GB (ZIP64).
// Liest das Inhaltsverzeichnis und entpackt einzelne Einträge bei Bedarf.

'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = fs.readSync(fd, b, off, len - off, pos + off);
    if (!n) break;
    off += n;
  }
  return b.subarray(0, off);
}

function u64(b, at) {
  return Number(b.readBigUInt64LE(at));
}

class ZipFile {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'r');
    this.size = fs.fstatSync(this.fd).size;
    this.entries = this.readDirectory();
  }

  close() {
    try { fs.closeSync(this.fd); } catch { /* egal */ }
  }

  readDirectory() {
    // Ende des Inhaltsverzeichnisses suchen (max. 64 KB Kommentar)
    const tailLen = Math.min(this.size, 65557);
    const tail = readAt(this.fd, this.size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error(`${this.file}: keine gültige ZIP-Datei`);
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    // ZIP64?
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locAt = eocd - 20;
      if (locAt >= 0 && tail.readUInt32LE(locAt) === 0x07064b50) {
        const z64Offset = u64(tail, locAt + 8);
        const z = readAt(this.fd, z64Offset, 56);
        if (z.readUInt32LE(0) !== 0x06064b50) throw new Error(`${this.file}: ZIP64-Verzeichnis fehlt`);
        count = u64(z, 32);
        cdSize = u64(z, 40);
        cdOffset = u64(z, 48);
      }
    }
    const cd = readAt(this.fd, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error(`${this.file}: Inhaltsverzeichnis beschädigt`);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
      // ZIP64-Zusatzfeld
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
          if (compSize === 0xffffffff) { compSize = u64(cd, q); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = u64(cd, q); q += 8; }
        }
        e += 4 + len;
      }
      p = eEnd + commentLen;
      if (name.endsWith('/')) continue;
      entries.push({ name, method, compSize, size, localOffset, encrypted: !!(flags & 1) });
    }
    return entries;
  }

  dataStart(entry) {
    const h = readAt(this.fd, entry.localOffset, 30);
    if (h.readUInt32LE(0) !== 0x04034b50) throw new Error(`${entry.name}: Eintrag beschädigt`);
    return entry.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  }

  // kleinen Eintrag in den Speicher entpacken
  read(entry) {
    if (entry.encrypted) throw new Error(`${entry.name}: verschlüsselt`);
    const raw = readAt(this.fd, this.dataStart(entry), entry.compSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`${entry.name}: Kompressionsart ${entry.method} nicht unterstützt`);
  }

  // großen Eintrag (z. B. eine ZIP in der ZIP) auf die Platte entpacken
  async extractTo(entry, target) {
    if (entry.encrypted) throw new Error(`${entry.name}: verschlüsselt`);
    const start = this.dataStart(entry);
    const src = fs.createReadStream(null, { fd: this.fd, autoClose: false, start, end: start + entry.compSize - 1 });
    const dst = fs.createWriteStream(target);
    if (entry.method === 0) await pipeline(src, dst);
    else if (entry.method === 8) await pipeline(src, zlib.createInflateRaw(), dst);
    else throw new Error(`${entry.name}: Kompressionsart ${entry.method} nicht unterstützt`);
  }
}

module.exports = { ZipFile };
