// Garmin-Export importieren
// Liest den Datenexport von Garmin Connect („Daten exportieren“, eine große ZIP)
// aus dem Ordner data/import, ordnet den Aktivitätsdateien ihre Namen aus
// Garmin zu und lädt sie einzeln über die Datei-Import-Schnittstelle von
// OpenAthlete hoch (POST /activity-import/fit|gpx|tcx).
// Multisport-Dateien (Triathlon …) werden vorher in einzelne Abschnitte geteilt,
// weil OpenAthlete nur Dateien mit einem Abschnitt annimmt.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ZipFile } = require('./zip');
const { inspectFit, splitMultisport, fitToDate } = require('./fit');

const MATCH_WINDOW_MS = 3 * 60000; // Startzeit FIT ↔ Garmin-Liste
const UPLOAD_GAP_MS = Number(process.env.EXPORT_UPLOAD_GAP_MS || 150);
const KINDS = { '.fit': 'fit', '.gpx': 'gpx', '.tcx': 'tcx' };

const ERRORS = {
  FIT_INVALID: 'Datei beschädigt oder unvollständig',
  FIT_NOT_ACTIVITY: 'keine Aktivität',
  FIT_MULTISPORT_UNSUPPORTED: 'Multisport-Datei ließ sich nicht teilen',
  FIT_LIMIT: 'Datei zu groß',
  GPX_INVALID: 'GPX-Datei beschädigt',
  GPX_NO_TIME: 'GPX ohne Zeiten (geplante Route)',
  GPX_LIMIT: 'GPX-Datei zu groß',
  TCX_INVALID: 'TCX-Datei beschädigt',
  TCX_NO_TIME: 'TCX ohne Zeiten (Strecke oder Training)',
  TCX_MULTISPORT_UNSUPPORTED: 'TCX-Multisport wird nicht unterstützt',
  TCX_LIMIT: 'TCX-Datei zu groß',
};

function kindOf(name) {
  return KINDS[path.extname(name).toLowerCase()] || null;
}
const isZip = (name) => path.extname(name).toLowerCase() === '.zip';
const isSummary = (name) => /summarizedActivities.*\.json$/i.test(name);
// Dateien im Export, die keine Aktivitäten sind (inReach-Karten, Routen …)
const isIgnored = (name) => /(^|[\\/])INREACH[\\/]/i.test(name) || /(^|[\\/])mapdata-[^\\/]*$/i.test(name);

// erste Zeitangabe in GPX/TCX
function xmlStart(buf) {
  const m = buf.toString('utf8', 0, Math.min(buf.length, 200000)).match(/<(?:\w+:)?(?:time|Time|Id)>\s*([0-9]{4}-[0-9]{2}-[0-9]{2}T[^<\s]+)\s*</);
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : null;
}

// Aktivitätsliste aus summarizedActivities.json: [{ start(ms), name, type }]
function collectSummaries(data, out) {
  if (Array.isArray(data)) { for (const x of data) collectSummaries(x, out); return; }
  if (!data || typeof data !== 'object') return;
  const start = data.startTimeGmt ?? data.beginTimestamp;
  const name = data.name ?? data.activityName;
  if (typeof start === 'number' && typeof name === 'string') {
    out.push({ start, name: name.trim(), type: data.activityType || data.sportType || null, parent: !!(data.parent || data.isParent) });
    return;
  }
  for (const v of Object.values(data)) if (v && typeof v === 'object') collectSummaries(v, out);
}

function createExportImporter({ dataDir, upload, applyRules }) {
  const importDir = path.join(dataDir, 'import');
  const tmpDir = path.join(dataDir, 'tmp');
  const stateFile = path.join(dataDir, 'garmin-export.json');
  fs.mkdirSync(importDir, { recursive: true });

  let job = null;
  let tokens = null;
  let runner = null;

  try {
    job = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (job && (job.status === 'running' || job.status === 'scanning')) {
      job.status = job.status === 'scanning' ? 'failed' : 'paused';
      job.phase = job.status === 'paused'
        ? 'Nach einem Neustart angehalten. Zum Fortsetzen anmelden und „Fortsetzen“ klicken.'
        : 'Prüfung durch Neustart unterbrochen. Bitte neu prüfen.';
    }
  } catch {
    job = null;
  }

  function save() {
    try { fs.writeFileSync(stateFile, JSON.stringify(job)); } catch (e) { console.error('Export-Zustand nicht gespeichert:', e.message); }
  }
  function addLog(text) {
    job.log.push({ zeit: new Date().toISOString(), text });
    if (job.log.length > 500) job.log.splice(0, job.log.length - 500);
  }
  function cleanTmp() {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* egal */ }
  }
  function checkCancel() {
    if (job.cancel) throw new Error('__cancel');
  }

  // Dateien und Ordner im Import-Ordner
  function listSources() {
    let names = [];
    try { names = fs.readdirSync(importDir, { withFileTypes: true }); } catch { return []; }
    return names
      .filter((d) => !d.name.startsWith('.'))
      .map((d) => {
        const full = path.join(importDir, d.name);
        let size = null;
        try { size = d.isDirectory() ? null : fs.statSync(full).size; } catch { /* egal */ }
        return { name: d.name, dir: d.isDirectory(), size };
      })
      .filter((s) => s.dir || isZip(s.name) || kindOf(s.name) || isSummary(s.name));
  }

  // --- Quellen durchlaufen --------------------------------------------------
  // Ein „Container“ ist ein Ordner, eine ZIP oder eine ZIP in einer ZIP.
  // visit(container, entryName, readBuffer) wird für jede passende Datei aufgerufen.
  async function walkContainer(c, visit, onContainer) {
    if (c.type === 'dir') {
      const stack = [c.path];
      while (stack.length) {
        const dir = stack.pop();
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, d.name);
          if (d.isDirectory()) stack.push(full);
          else if (isZip(d.name)) onContainer({ type: 'zip', path: full });
          else if ((kindOf(d.name) && !isIgnored(full)) || isSummary(d.name)) await visit(c, full, () => fs.readFileSync(full));
        }
      }
      return;
    }
    const zip = await openZip(c);
    try {
      for (const e of zip.entries) {
        checkCancel();
        if (isZip(e.name)) {
          // Nur die Aktivitätsdateien; andere ZIPs im Export (inReach-Tracks,
          // Geräte-Backups, EKG …) sind keine Aktivitäten
          if (c.type === 'zip' && /UploadedFiles/i.test(path.basename(e.name)) && !/Health/i.test(e.name)) {
            onContainer({ type: 'nested', path: c.path, entry: e.name });
          }
          continue;
        }
        if ((kindOf(e.name) && !isIgnored(e.name)) || isSummary(e.name)) await visit(c, e.name, () => zip.read(e));
      }
    } finally {
      zip.close();
    }
  }

  async function openZip(c) {
    if (c.type === 'zip') return new ZipFile(c.path);
    // ZIP in der ZIP: erst auf die Platte entpacken
    fs.mkdirSync(tmpDir, { recursive: true });
    const target = path.join(tmpDir, 'inner.zip');
    const outer = new ZipFile(c.path);
    try {
      const e = outer.entries.find((x) => x.name === c.entry);
      if (!e) throw new Error(`${c.entry} nicht mehr in ${path.basename(c.path)} gefunden`);
      job.phase = `Entpacke ${path.basename(c.entry)} …`;
      save();
      await outer.extractTo(e, target);
    } finally {
      outer.close();
    }
    const zip = new ZipFile(target);
    const close = zip.close.bind(zip);
    zip.close = () => { close(); try { fs.unlinkSync(target); } catch { /* egal */ } };
    return zip;
  }

  // --- Prüfen ---------------------------------------------------------------
  async function scan(source) {
    const full = source ? path.join(importDir, source) : importDir;
    if (!full.startsWith(importDir)) throw new Error('Ungültiger Pfad');
    const st = fs.statSync(full);
    const queue = [st.isDirectory() ? { type: 'dir', path: full } : isZip(full) ? { type: 'zip', path: full } : { type: 'dir', path: path.dirname(full) }];
    const containers = [];
    const items = [];
    const summaries = [];
    const stats = { files: 0, activities: 0, multisport: 0, nonActivity: 0, unreadable: 0 };
    while (queue.length) {
      checkCancel();
      const c = queue.shift();
      c.id = containers.length;
      containers.push(c);
      job.phase = `Prüfe ${path.basename(c.entry || c.path)} …`;
      save();
      await walkContainer(c, async (cont, name, read) => {
        checkCancel();
        if (isSummary(name)) {
          try { collectSummaries(JSON.parse(read().toString('utf8')), summaries); } catch (e) { addLog(`Aktivitätsliste ${path.basename(name)} nicht lesbar: ${e.message}`); }
          return;
        }
        stats.files++;
        const kind = kindOf(name);
        let buf;
        try { buf = read(); } catch (e) { stats.unreadable++; addLog(`✗ ${path.basename(name)}: ${e.message}`); return; }
        const item = { c: cont.id, e: name, kind, status: 'pending' };
        if (kind === 'fit') {
          let info;
          try { info = inspectFit(buf); } catch (e) { stats.unreadable++; addLog(`✗ ${path.basename(name)}: ${e.message}`); return; }
          if (info.fileType !== 4 || !info.sessions.length) { stats.nonActivity++; return; }
          const s0 = info.sessions[0];
          item.start = s0.start != null ? fitToDate(s0.start).getTime() : null;
          if (info.sessions.length > 1) {
            item.multisport = true;
            item.legs = info.sessions.length;
            stats.multisport++;
          }
        } else {
          item.start = xmlStart(buf);
        }
        stats.activities++;
        items.push(item);
        if (stats.files % 50 === 0) {
          job.phase = `Prüfe … ${stats.activities} Aktivitäten gefunden`;
          job.scan = { ...stats };
          save();
        }
      }, (child) => queue.push(child));
    }

    // Namen zuordnen
    summaries.sort((a, b) => a.start - b.start);
    let named = 0;
    for (const it of items) {
      if (it.start == null) continue;
      let best = null;
      for (const s of summaries) {
        const d = Math.abs(s.start - it.start);
        if (d <= MATCH_WINDOW_MS && (!best || d < best.d || (d === best.d && s.parent))) best = { d, s };
      }
      if (best) { it.name = best.s.name.slice(0, 100); named++; }
    }
    // Ohne Aktivitätsliste im Export lässt sich nichts zuordnen: dann alles importieren
    job.hasSummaries = summaries.length > 0;
    items.sort((a, b) => (a.c - b.c) || ((a.start || 0) - (b.start || 0)));
    const starts = items.map((i) => i.start).filter((t) => t != null);
    job.containers = containers;
    job.items = items;
    job.scan = {
      ...stats,
      named,
      unnamed: items.length - named,
      summaries: summaries.length,
      from: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
      to: starts.length ? new Date(Math.max(...starts)).toISOString() : null,
    };
    addLog(`Geprüft: ${stats.activities} Aktivitäten (${stats.multisport} Multisport), ${named} mit Namen aus Garmin, ${stats.nonActivity} andere Dateien übersprungen${stats.unreadable ? `, ${stats.unreadable} nicht lesbar` : ''}.`);
  }

  // --- Hochladen ------------------------------------------------------------
  function fallbackName(it) {
    const d = it.start ? new Date(it.start) : null;
    return d ? `Garmin ${d.toISOString().slice(0, 10)}` : 'Garmin-Aktivität';
  }

  async function uploadOne(kind, buffer, filename, name) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      checkCancel();
      const r = await upload(tokens, kind, buffer, filename, name);
      if (r.status === 429) {
        job.phase = 'OpenAthlete bremst (zu viele Anfragen), warte 1 Minute …';
        save();
        await sleep(60000);
        continue;
      }
      if (r.status === 401) throw new Error('Anmeldung abgelaufen. Bitte neu anmelden und „Fortsetzen“ klicken.');
      if (r.ok) return { status: r.data && r.data.alreadyImported ? 'exists' : 'imported' };
      const code = r.data && (r.data.message || r.data.error);
      const c = Array.isArray(code) ? code.join(', ') : String(code || r.status);
      if (r.status === 409 || /DUPLICATE/.test(c)) return { status: 'exists' };
      if (r.status >= 500 && attempt < 3) { await sleep(5000); continue; }
      return { status: 'failed', error: ERRORS[c] || c };
    }
    return { status: 'failed', error: 'zu viele Versuche' };
  }

  async function sleep(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      checkCancel();
      await new Promise((r) => setTimeout(r, Math.min(500, until - Date.now())));
    }
  }

  async function importItems() {
    const byContainer = new Map();
    job.items.forEach((it, idx) => {
      if (it.status !== 'pending') return;
      if (!byContainer.has(it.c)) byContainer.set(it.c, []);
      byContainer.get(it.c).push(idx);
    });
    for (const [cid, idxs] of byContainer) {
      const c = job.containers[cid];
      let zip = null;
      try {
        if (c.type !== 'dir') zip = await openZip(c);
        const entries = zip ? new Map(zip.entries.map((e) => [e.name, e])) : null;
        for (const idx of idxs) {
          checkCancel();
          const it = job.items[idx];
          job.current = idx;
          // Datei ohne Eintrag in Garmins Liste (meist in Garmin gelöscht): auf Wunsch überspringen
          if (!it.name && job.hasSummaries && !job.importUnnamed) {
            it.status = 'skipped';
            job.totals.skipped = (job.totals.skipped || 0) + 1;
            continue;
          }
          const base = it.name || fallbackName(it);
          job.phase = `Lade hoch: ${base}`;
          let buf;
          try {
            if (zip) {
              const e = entries.get(it.e);
              if (!e) throw new Error('Datei nicht mehr im Export');
              buf = zip.read(e);
            } else buf = fs.readFileSync(it.e);
          } catch (e) {
            it.status = 'failed'; it.error = e.message; job.totals.failed++;
            continue;
          }
          const filename = path.basename(it.e);
          if (it.multisport) {
            let parts;
            try { parts = splitMultisport(buf); } catch (e) { parts = []; it.error = e.message; }
            if (!parts.length) { it.status = 'failed'; it.error = it.error || 'ließ sich nicht teilen'; job.totals.failed++; continue; }
            const res = [];
            for (const p of parts) {
              const r = await uploadOne('fit', p.buffer, filename.replace(/\.fit$/i, `_${p.label.replace(/\s/g, '')}.fit`), `${base.slice(0, 85)} – ${p.label}`);
              res.push(r);
              if (r.status === 'failed') it.error = `${p.label}: ${r.error}`;
              await sleep(UPLOAD_GAP_MS);
            }
            it.parts = res.length;
            it.status = res.some((r) => r.status === 'failed') ? 'failed' : res.some((r) => r.status === 'imported') ? 'imported' : 'exists';
            job.totals.splitParts += res.filter((r) => r.status === 'imported').length;
          } else {
            const r = await uploadOne(it.kind, buf, filename, base);
            it.status = r.status;
            if (r.error) it.error = r.error;
            await sleep(UPLOAD_GAP_MS);
          }
          job.totals[it.status === 'imported' ? 'imported' : it.status === 'exists' ? 'exists' : 'failed']++;
          if (it.status === 'failed') addLog(`✗ ${base} (${it.start ? new Date(it.start).toISOString().slice(0, 10) : '?'}): ${it.error}`);
          if ((job.totals.imported + job.totals.exists + job.totals.failed) % 10 === 0) save();
        }
      } finally {
        if (zip) zip.close();
        save();
      }
    }
  }

  async function run(fn) {
    job.cancel = false;
    save();
    try {
      await fn();
    } catch (e) {
      if (e.message === '__cancel') {
        job.status = job.status === 'scanning' ? 'failed' : 'cancelled';
        job.phase = job.status === 'cancelled' ? 'Abgebrochen. Mit „Fortsetzen“ geht es weiter.' : 'Prüfung abgebrochen.';
        addLog('Vom Benutzer abgebrochen.');
      } else {
        job.status = job.status === 'scanning' ? 'failed' : 'paused';
        job.phase = e.message;
        addLog(`Angehalten: ${e.message}`);
        console.error(e);
      }
    } finally {
      job.cancel = false;
      job.current = null;
      cleanTmp();
      save();
      runner = null;
    }
  }

  async function doImport() {
    job.status = 'running';
    await importItems();
    const done = job.items.filter((i) => i.status === 'imported' && i.start);
    if (job.applyRules && applyRules && done.length) {
      const from = new Date(Math.min(...done.map((i) => i.start))).toISOString().slice(0, 10);
      const to = new Date(Math.max(...done.map((i) => i.start))).toISOString().slice(0, 10);
      job.phase = 'Wende deine Regeln auf die importierten Aktivitäten an …';
      save();
      try {
        const r = await applyRules(tokens, from, to);
        job.rulesResult = { checked: r.checked, changed: r.changed.length, failed: r.failed.length, noRules: r.noRules };
        if (!r.noRules) addLog(`Regeln angewendet: ${r.changed.length} geändert${r.failed.length ? `, ${r.failed.length} fehlgeschlagen` : ''}.`);
      } catch (e) {
        job.rulesResult = { error: e.message };
        addLog(`✗ Regeln konnten nicht angewendet werden: ${e.message}`);
      }
    }
    job.status = 'done';
    job.phase = 'Fertig.';
    addLog(`Import fertig: ${job.totals.imported} neu (Multisport als ${job.totals.splitParts} Einzelaktivitäten), ${job.totals.exists} schon vorhanden, ${job.totals.skipped || 0} ohne Eintrag in Garmin übersprungen, ${job.totals.failed} fehlgeschlagen.`);
  }

  function publicState() {
    if (!job) return null;
    const failed = job.items ? job.items.filter((i) => i.status === 'failed').slice(0, 200).map((i) => ({
      name: i.name || fallbackName(i), date: i.start ? new Date(i.start).toISOString().slice(0, 10) : null, error: i.error,
    })) : [];
    const pending = job.items ? job.items.filter((i) => i.status === 'pending').length : 0;
    return {
      status: job.status, source: job.source, phase: job.phase, scan: job.scan || null,
      total: job.items ? job.items.length : 0, pending, totals: job.totals, applyRules: job.applyRules,
      importUnnamed: !!job.importUnnamed, hasSummaries: !!job.hasSummaries,
      rulesResult: job.rulesResult || null, failed, log: job.log.slice(-200),
    };
  }

  return {
    importDir,
    sources: listSources,
    state: publicState,
    scan(session, { source }) {
      if (runner) throw new Error('Es läuft bereits ein Vorgang.');
      const src = typeof source === 'string' ? source : '';
      if (src && !listSources().some((s) => s.name === src)) throw new Error('Datei nicht im Import-Ordner gefunden.');
      tokens = { accessToken: session.accessToken, refreshToken: session.refreshToken };
      job = {
        createdAt: new Date().toISOString(), konto: session.email, source: src || '(ganzer Import-Ordner)',
        status: 'scanning', phase: 'Starte Prüfung …', log: [], items: null, containers: null,
        totals: { imported: 0, exists: 0, failed: 0, skipped: 0, splitParts: 0 }, applyRules: true, rulesResult: null,
      };
      runner = run(async () => {
        await scan(src);
        job.status = 'ready';
        job.phase = job.items.length ? 'Bereit zum Import.' : 'Keine Aktivitätsdateien gefunden.';
      });
      return publicState();
    },
    start(session, { applyRules: withRules, importUnnamed } = {}) {
      if (runner) throw new Error('Es läuft bereits ein Vorgang.');
      if (!job || job.status !== 'ready' || !job.items || !job.items.length) throw new Error('Bitte zuerst den Export prüfen.');
      tokens = { accessToken: session.accessToken, refreshToken: session.refreshToken };
      job.applyRules = withRules !== false;
      job.importUnnamed = importUnnamed === true;
      addLog(`Import von ${job.items.length} Aktivitäten gestartet.`);
      runner = run(doImport);
      return publicState();
    },
    resume(session) {
      if (runner) throw new Error('Es läuft bereits ein Vorgang.');
      if (!job || !job.items || !job.items.some((i) => i.status === 'pending')) throw new Error('Nichts fortzusetzen.');
      tokens = { accessToken: session.accessToken, refreshToken: session.refreshToken };
      addLog('Fortgesetzt.');
      runner = run(doImport);
      return publicState();
    },
    retryFailed(session) {
      if (runner) throw new Error('Es läuft bereits ein Vorgang.');
      if (!job || !job.items) throw new Error('Kein Import vorhanden.');
      let n = 0;
      for (const it of job.items) if (it.status === 'failed') { it.status = 'pending'; delete it.error; n++; }
      if (!n) throw new Error('Keine fehlgeschlagenen Aktivitäten.');
      job.totals.failed = Math.max(0, job.totals.failed - n);
      return this.resume(session);
    },
    cancel() {
      if (!runner) throw new Error('Es läuft nichts.');
      job.cancel = true;
      return publicState();
    },
    clear() {
      if (runner) throw new Error('Erst abbrechen, dann löschen.');
      job = null;
      try { fs.unlinkSync(stateFile); } catch { /* egal */ }
      cleanTmp();
      return null;
    },
  };
}

module.exports = { createExportImporter, collectSummaries, xmlStart };
