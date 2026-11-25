// Minimaler FIT-Leser und -Teiler (ohne Zusatzpakete).
// Wird gebraucht, weil OpenAthlete Multisport-Dateien (Triathlon, Duathlon …)
// ablehnt: Jede FIT-Datei darf nur einen Abschnitt (Session) haben. Wir teilen
// eine Multisport-Datei deshalb in eine Datei pro Disziplin. Wechselzonen
// werden eigene Aktivitäten (OpenAthlete ordnet sie „Sonstiges“ zu).

'use strict';

const FIT_EPOCH_MS = Date.UTC(1989, 11, 31, 0, 0, 0);

// Globale Nachrichtennummern aus dem FIT-Profil
const MSG = {
  FILE_ID: 0,
  SESSION: 18,
  LAP: 19,
  RECORD: 20,
  EVENT: 21,
  ACTIVITY: 34,
  HRV: 78,
  LENGTH: 101,
  SPLIT: 312,
  SPLIT_SUMMARY: 313,
  TIME_IN_ZONE: 216,
  HR: 132,
};

// Nachrichten, die unabhängig von der Zeit in jede Teildatei gehören
const KEEP_ALWAYS = new Set([0, 2, 3, 7, 12, 13, 23, 34, 49, 162, 206, 207]);

// Sportarten (FIT-Enum „sport“)
const SPORT = { 0: 'Sport', 1: 'Laufen', 2: 'Rad', 3: 'Wechsel', 5: 'Schwimmen', 11: 'Gehen', 17: 'Wandern', 15: 'Rudern', 41: 'Kajak', 37: 'SUP' };
const TRANSITION = 3;

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];
function crc16(buf, start = 0, end = buf.length) {
  let crc = 0;
  for (let i = start; i < end; i++) {
    const byte = buf[i];
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf];
  }
  return crc;
}

const INVALID_U32 = 0xffffffff;

// FIT-Datei in Nachrichten zerlegen. Jede Nachricht behält ihre Rohbytes,
// damit wir sie unverändert (oder minimal angepasst) wieder schreiben können.
function parseFit(buf) {
  if (buf.length < 14) throw new Error('Datei zu kurz');
  const headerSize = buf[0];
  if (headerSize !== 12 && headerSize !== 14) throw new Error('Kein FIT-Header');
  if (buf.toString('ascii', 8, 12) !== '.FIT') throw new Error('Keine FIT-Datei');
  const dataSize = buf.readUInt32LE(4);
  const end = headerSize + dataSize;
  if (end + 2 > buf.length) throw new Error('FIT-Datei unvollständig');
  if (crc16(buf, 0, end) !== buf.readUInt16LE(end)) throw new Error('FIT-Prüfsumme falsch');

  const defs = new Map(); // lokaler Typ → Definition
  const messages = [];
  let pos = headerSize;
  let lastTimestamp = 0;
  while (pos < end) {
    const start = pos;
    const h = buf[pos++];
    if (h & 0x80) {
      // komprimierter Zeitstempel
      const local = (h >> 5) & 0x03;
      const def = defs.get(local);
      if (!def) throw new Error('Nachricht ohne Definition');
      const offset = h & 0x1f;
      let ts = (lastTimestamp & ~0x1f) + offset;
      if (offset < (lastTimestamp & 0x1f)) ts += 0x20;
      lastTimestamp = ts;
      pos += def.size;
      messages.push({ kind: 'data', start, end: pos, def, timestamp: ts, compressed: true });
      continue;
    }
    const local = h & 0x0f;
    if (h & 0x40) {
      // Definition
      const arch = buf[pos + 1];
      const le = arch === 0;
      const global = le ? buf.readUInt16LE(pos + 2) : buf.readUInt16BE(pos + 2);
      const n = buf[pos + 4];
      pos += 5;
      const fields = new Map();
      let size = 0;
      for (let i = 0; i < n; i++) {
        const num = buf[pos];
        const fsize = buf[pos + 1];
        fields.set(num, { offset: size, size: fsize, base: buf[pos + 2] });
        size += fsize;
        pos += 3;
      }
      if (h & 0x20) {
        const nd = buf[pos++];
        for (let i = 0; i < nd; i++) {
          size += buf[pos + 1];
          pos += 3;
        }
      }
      const def = { global, le, fields, size };
      defs.set(local, def);
      messages.push({ kind: 'def', start, end: pos, def });
      continue;
    }
    const def = defs.get(local);
    if (!def) throw new Error('Nachricht ohne Definition');
    const body = pos;
    pos += def.size;
    const msg = { kind: 'data', start, end: pos, def, body };
    const ts = readField(buf, msg, 253);
    if (ts != null) {
      msg.timestamp = ts;
      lastTimestamp = ts;
    }
    messages.push(msg);
  }
  return { headerSize, messages, buf };
}

function readField(buf, msg, num) {
  const f = msg.def.fields.get(num);
  if (!f || msg.body == null) return null;
  const at = msg.body + f.offset;
  let v;
  if (f.size === 1) v = buf[at];
  else if (f.size === 2) v = msg.def.le ? buf.readUInt16LE(at) : buf.readUInt16BE(at);
  else if (f.size === 4) v = msg.def.le ? buf.readUInt32LE(at) : buf.readUInt32BE(at);
  else return null;
  const invalid = f.size === 1 ? 0xff : f.size === 2 ? 0xffff : INVALID_U32;
  return v === invalid ? null : v;
}

function writeField(out, msgOutStart, msg, num, value) {
  const f = msg.def.fields.get(num);
  if (!f || msg.body == null) return;
  const at = msgOutStart + 1 + f.offset; // 1 Byte Kopf
  if (f.size === 1) out[at] = value;
  else if (f.size === 2) msg.def.le ? out.writeUInt16LE(value, at) : out.writeUInt16BE(value, at);
  else if (f.size === 4) msg.def.le ? out.writeUInt32LE(value >>> 0, at) : out.writeUInt32BE(value >>> 0, at);
}

const fitToDate = (ts) => new Date(FIT_EPOCH_MS + ts * 1000);

// Überblick über eine FIT-Datei: Typ und Abschnitte
function inspectFit(buf) {
  const fit = parseFit(buf);
  let fileType = null;
  const sessions = [];
  for (const m of fit.messages) {
    if (m.kind !== 'data') continue;
    if (m.def.global === MSG.FILE_ID && fileType == null) fileType = readField(buf, m, 0);
    if (m.def.global === MSG.SESSION) {
      const start = readField(buf, m, 2);
      const elapsed = readField(buf, m, 7);
      sessions.push({
        msg: m,
        sport: readField(buf, m, 5),
        subSport: readField(buf, m, 6),
        start,
        elapsed: elapsed == null ? null : elapsed / 1000,
      });
    }
  }
  return { fit, fileType, sessions };
}

// Multisport-Datei in eine Datei pro Abschnitt teilen.
// Liefert [{ buffer, sport, label, startDate }].
function splitMultisport(buf, { withTransitions = true } = {}) {
  const { fit, sessions } = inspectFit(buf);
  const legs = sessions.filter((s) => s.start != null && s.elapsed != null && (withTransitions || s.sport !== TRANSITION));
  const out = [];
  let transitions = 0;
  const starts = sessions.map((s) => s.start).filter((t) => t != null).sort((a, b) => a - b);
  // kommt eine Sportart mehrfach vor (z. B. zwei Rad-Abschnitte): nummerieren
  const total = {};
  for (const l of legs) if (l.sport !== TRANSITION) total[l.sport] = (total[l.sport] || 0) + 1;
  const seen = {};
  for (const leg of legs) {
    const from = leg.start;
    const next = starts.find((t) => t > from);
    // bis zum Ende des Abschnitts, aber nicht in den nächsten hinein
    const to = Math.min(leg.start + Math.ceil(leg.elapsed), next != null ? next - 1 : Infinity);
    const inWindow = (t) => t != null && t >= from && t <= to;

    // Distanz der Messpunkte beginnt bei jeder Disziplin wieder bei 0
    let distBase = null;
    for (const m of fit.messages) {
      if (m.kind === 'data' && m.def.global === MSG.RECORD && inWindow(m.timestamp)) {
        const d = readField(buf, m, 5);
        if (d != null) { distBase = d; break; }
      }
    }

    const keep = [];
    let lapIndex = 0;
    for (const m of fit.messages) {
      if (m.kind === 'def') { keep.push({ m }); continue; }
      const g = m.def.global;
      if (g === MSG.SESSION) {
        if (m === leg.msg) keep.push({ m, patch: [[25, 0]] }); // first_lap_index
        continue;
      }
      if (g === MSG.LAP) {
        const s = readField(buf, m, 2) ?? m.timestamp;
        if (inWindow(s)) { keep.push({ m, patch: [[254, lapIndex++]] }); }
        continue;
      }
      if (g === MSG.RECORD) {
        if (!inWindow(m.timestamp)) continue;
        const d = readField(buf, m, 5);
        keep.push({ m, patch: d != null && distBase != null ? [[5, Math.max(0, d - distBase)]] : null });
        continue;
      }
      if (g === MSG.LENGTH) {
        const s = readField(buf, m, 2) ?? m.timestamp;
        if (inWindow(s)) keep.push({ m });
        continue;
      }
      if (g === MSG.EVENT || g === MSG.SPLIT || g === MSG.TIME_IN_ZONE) {
        if (m.timestamp == null || inWindow(m.timestamp)) keep.push({ m });
        continue;
      }
      if (g === MSG.HRV || g === MSG.SPLIT_SUMMARY) continue; // lassen sich nicht sauber teilen
      if (g === MSG.ACTIVITY) { keep.push({ m, patch: [[1, 1]] }); continue; } // num_sessions
      // Herzfrequenz-Blöcke (Brustgurt beim Schwimmen) werden beim Lesen den
      // Messpunkten zugeordnet; die gehören deshalb alle mit hinein
      if (g === MSG.HR || KEEP_ALWAYS.has(g) || m.timestamp == null || inWindow(m.timestamp)) keep.push({ m });
    }

    const size = keep.reduce((n, k) => n + (k.m.end - k.m.start), 0);
    const header = Buffer.alloc(14);
    header[0] = 14;
    header[1] = buf[1];
    header.writeUInt16LE(buf.readUInt16LE(2), 2);
    header.writeUInt32LE(size, 4);
    header.write('.FIT', 8, 'ascii');
    header.writeUInt16LE(crc16(header, 0, 12), 12);
    const file = Buffer.alloc(14 + size + 2);
    header.copy(file, 0);
    let p = 14;
    for (const k of keep) {
      buf.copy(file, p, k.m.start, k.m.end);
      if (k.patch && !k.m.compressed) for (const [num, v] of k.patch) writeField(file, p, k.m, num, v);
      p += k.m.end - k.m.start;
    }
    file.writeUInt16LE(crc16(file, 0, p), p);
    let label;
    if (leg.sport === TRANSITION) label = `Wechsel ${++transitions}`;
    else {
      seen[leg.sport] = (seen[leg.sport] || 0) + 1;
      label = (SPORT[leg.sport] || 'Sport') + (total[leg.sport] > 1 ? ` ${seen[leg.sport]}` : '');
    }
    out.push({ buffer: file, sport: leg.sport, label, startDate: fitToDate(leg.start) });
  }
  return out;
}

module.exports = { parseFit, inspectFit, splitMultisport, fitToDate, crc16, TRANSITION };
