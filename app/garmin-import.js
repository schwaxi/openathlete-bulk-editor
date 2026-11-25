// Garmin-Verlauf-Import
// Teilt einen langen Zeitraum in Abschnitte von höchstens 28 Tagen und lässt
// OpenAthlete diese nacheinander über die offizielle Schnittstelle
// (POST /provider/garmin-personal/sync) importieren. Läuft im Server weiter,
// auch wenn das Browserfenster geschlossen ist.
//
// Grenzen von OpenAthlete, die hier eingehalten werden:
//  - höchstens 28 Kalendertage pro Import
//  - höchstens 3 Import-Aufträge pro 15 Minuten
//  - immer nur ein Import gleichzeitig

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DAY = 86400000;
const MAX_DAYS = 28;
const THROTTLE_WINDOW_MS = Number(process.env.GARMIN_THROTTLE_MS || 15 * 60000);
const THROTTLE_MAX = 3;
const POLL_MS = Number(process.env.GARMIN_POLL_MS || 10000);
const CHUNK_TIMEOUT_MS = Number(process.env.GARMIN_CHUNK_TIMEOUT_MS || 90 * 60000);

const ACTIVE = new Set(['queued', 'running']);

function isoDay(d) {
  return new Date(d).toISOString().slice(0, 10);
}
function parseDay(s) {
  return Date.parse(`${s}T00:00:00Z`);
}
function todayUtc() {
  return isoDay(Date.now());
}

// Zeitraum in Abschnitte von höchstens 28 Tagen teilen
function makeChunks(startDate, endDate, order) {
  const chunks = [];
  let s = parseDay(startDate);
  const end = parseDay(endDate);
  while (s <= end) {
    const e = Math.min(s + (MAX_DAYS - 1) * DAY, end);
    chunks.push({ startDate: isoDay(s), endDate: isoDay(e), status: 'pending' });
    s = e + DAY;
  }
  if (order === 'desc') chunks.reverse();
  return chunks;
}

const QUICK_DAYS = 7; // ohne früheren Import: so viele Tage zurück
const AUTO_MIN_GAP_MS = 30 * 60000; // automatisches Holen höchstens alle 30 Minuten

function createImporter({ authed, dataDir, apiError, applyRules }) {
  const stateFile = path.join(dataDir, 'garmin-import.json');
  const quickFile = path.join(dataDir, 'garmin-neu.json');
  let quick = {}; // { lastEnd: 'YYYY-MM-DD', lastRunAt: ISO }
  try { quick = JSON.parse(fs.readFileSync(quickFile, 'utf8')) || {}; } catch { quick = {}; }
  function saveQuick() {
    try { fs.writeFileSync(quickFile, JSON.stringify(quick, null, 2)); } catch (e) {
      console.error('Stand für „Neue Aktivitäten holen“ konnte nicht gespeichert werden:', e.message);
    }
  }
  let job = null; // gespeicherter Zustand (ohne Zugangsdaten)
  let tokens = null; // { accessToken, refreshToken } nur im Speicher
  let runner = null; // laufende Promise
  const postTimes = []; // Zeitpunkte der letzten Import-Aufträge

  // gespeicherten Zustand laden (z. B. nach Neustart des Containers)
  try {
    job = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (job && job.status === 'running') {
      job.status = 'paused';
      job.phase = 'Nach einem Neustart angehalten. Zum Fortsetzen anmelden und „Fortsetzen“ klicken.';
    }
  } catch {
    job = null;
  }

  function save() {
    try {
      fs.writeFileSync(stateFile, JSON.stringify(job, null, 2));
    } catch (e) {
      console.error('Import-Zustand konnte nicht gespeichert werden:', e.message);
    }
  }
  function setPhase(text, nextAt = null) {
    job.phase = text;
    job.nextAt = nextAt ? new Date(nextAt).toISOString() : null;
    save();
  }
  function addLog(text) {
    job.log.push({ zeit: new Date().toISOString(), text });
    if (job.log.length > 300) job.log.splice(0, job.log.length - 300);
    save();
  }

  // Warten, aber abbrechbar
  async function sleep(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (job.cancel) throw new Error('__cancel');
      await new Promise((r) => setTimeout(r, Math.min(1000, until - Date.now())));
    }
  }

  async function getStatus() {
    const r = await authed(tokens, 'GET', '/provider/garmin-personal');
    if (r.status === 401) throw new Error('Anmeldung abgelaufen. Bitte neu anmelden und „Fortsetzen“ klicken.');
    if (!r.ok) throw new Error(`Garmin-Status nicht abrufbar: ${apiError(r)}`);
    return r.data;
  }

  // warten, bis kein anderer Import (z. B. der stündliche Sync) mehr läuft
  async function waitIdle() {
    for (;;) {
      const st = await getStatus();
      if (!st.connected) throw new Error('Garmin ist in OpenAthlete nicht verbunden (Settings → Connectors → Garmin Personal API).');
      if (st.status === 'key_required') throw new Error('Garmin verlangt einen neuen Personal API Key. Bitte in OpenAthlete neu eintragen.');
      if (!st.preferences || !st.preferences.activities) throw new Error('Aktivitäten-Import ist in OpenAthlete ausgeschaltet (Garmin Personal API → Activities).');
      if (!ACTIVE.has(st.status) && !st.activeUntil) return st;
      setPhase('Warte, bis der laufende Garmin-Import in OpenAthlete fertig ist …', Date.now() + POLL_MS);
      await sleep(POLL_MS);
    }
  }

  // Limit: 3 Aufträge pro 15 Minuten
  async function waitThrottle() {
    for (;;) {
      const now = Date.now();
      while (postTimes.length && now - postTimes[0] > THROTTLE_WINDOW_MS) postTimes.shift();
      if (postTimes.length < THROTTLE_MAX) return;
      const next = postTimes[0] + THROTTLE_WINDOW_MS + 2000;
      setPhase('Pause wegen des Limits von OpenAthlete (3 Importe pro 15 Minuten) …', next);
      await sleep(next - now);
    }
  }

  async function runChunk(chunk) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = await waitIdle();
      await waitThrottle();
      setPhase(`Starte Import ${chunk.startDate} bis ${chunk.endDate} …`);
      const r = await authed(tokens, 'POST', '/provider/garmin-personal/sync', {
        startDate: chunk.startDate,
        endDate: chunk.endDate,
      });
      postTimes.push(Date.now());
      if (r.status === 429) {
        addLog('OpenAthlete meldet „zu viele Anfragen“, warte 5 Minuten.');
        setPhase('OpenAthlete bremst (zu viele Anfragen), warte 5 Minuten …', Date.now() + 5 * 60000);
        await sleep(5 * 60000);
        continue;
      }
      if (r.status === 401) throw new Error('Anmeldung abgelaufen. Bitte neu anmelden und „Fortsetzen“ klicken.');
      if (!r.ok) throw new Error(`Import abgelehnt: ${apiError(r)}`);

      // warten, bis dieser Import fertig ist
      const started = Date.now();
      for (;;) {
        setPhase(`Importiere ${chunk.startDate} bis ${chunk.endDate} …`, Date.now() + POLL_MS);
        await sleep(POLL_MS);
        const st = await getStatus();
        if (ACTIVE.has(st.status)) {
          if (Date.now() - started > CHUNK_TIMEOUT_MS) {
            throw new Error('Ein Import-Abschnitt dauert ungewöhnlich lange. Bitte in OpenAthlete nachsehen.');
          }
          continue;
        }
        const finished = st.lastSyncedAt && st.lastSyncedAt !== before.lastSyncedAt;
        if (!finished && st.status !== 'failed') {
          // Unser Auftrag wurde offenbar nicht angenommen (z. B. weil gerade
          // der stündliche Sync lief): noch einmal versuchen.
          if (Date.now() - started < 30000) continue;
          addLog(`Abschnitt ${chunk.startDate}–${chunk.endDate} wurde nicht ausgeführt, neuer Versuch (${attempt}/3).`);
          break;
        }
        if (st.status === 'failed') {
          chunk.status = 'failed';
          chunk.error = st.error || 'unbekannter Fehler';
          return;
        }
        chunk.result = st.result || null;
        chunk.status = st.status === 'partial' ? 'partial' : 'done';
        return;
      }
    }
    chunk.status = 'failed';
    chunk.error = 'Import wurde dreimal nicht ausgeführt';
  }

  async function run() {
    job.status = 'running';
    job.cancel = false;
    save();
    try {
      for (let i = 0; i < job.chunks.length; i++) {
        const chunk = job.chunks[i];
        if (chunk.status !== 'pending') continue;
        job.current = i;
        await runChunk(chunk);
        const res = chunk.result;
        if (chunk.status === 'failed') {
          addLog(`✗ ${chunk.startDate}–${chunk.endDate}: ${chunk.error}`);
        } else {
          addLog(
            `✓ ${chunk.startDate}–${chunk.endDate}: ${res ? `${res.imported} neu, ${res.matched} schon vorhanden, ${res.skipped} übersprungen, ${res.failed} fehlgeschlagen` : 'fertig'}`,
          );
          for (const k of ['imported', 'matched', 'skipped', 'needsReview', 'failed']) {
            job.totals[k] += (res && res[k]) || 0;
          }
          // Mehr als 1000 Aktivitäten in einem Abschnitt: in zwei Hälften teilen
          if (res && res.truncated) {
            const s = parseDay(chunk.startDate);
            const e = parseDay(chunk.endDate);
            if (e > s) {
              const mid = s + Math.floor((e - s) / DAY / 2) * DAY;
              job.chunks.splice(
                i + 1,
                0,
                { startDate: isoDay(s), endDate: isoDay(mid), status: 'pending' },
                { startDate: isoDay(mid + DAY), endDate: isoDay(e), status: 'pending' },
              );
              addLog('Abschnitt hatte über 1000 Aktivitäten, wird in zwei Hälften nachgeholt.');
            }
          }
        }
        save();
      }
      const failedChunks = job.chunks.filter((c) => c.status === 'failed').length;
      // Bis wann sind die Aktivitäten vollständig geholt? (für „Neue Aktivitäten holen“)
      if (!failedChunks && (!quick.lastEnd || job.endDate > quick.lastEnd)) {
        quick.lastEnd = job.endDate;
        saveQuick();
      }
      if (job.applyRules && applyRules) {
        job.current = null;
        setPhase('Wende deine Regeln auf die Aktivitäten im Zeitraum an …');
        try {
          const r = await applyRules(tokens, job.startDate, job.endDate);
          job.rulesResult = { checked: r.checked, changed: r.changed.length, failed: r.failed.length, noRules: r.noRules };
          if (r.noRules) addLog('Keine Regeln gespeichert, nichts angepasst.');
          else {
            for (const c of r.changed.slice(0, 100)) addLog(`Regel: „${c.name}“ (${c.date}) → ${c.text}`);
            if (r.changed.length > 100) addLog(`… und ${r.changed.length - 100} weitere per Regel geändert.`);
            for (const f of r.failed.slice(0, 50)) addLog(`✗ Regel bei „${f.name}“ (${f.date}): ${f.error}`);
            addLog(`Regeln angewendet: ${r.changed.length} geändert${r.failed.length ? `, ${r.failed.length} fehlgeschlagen` : ''}, ${r.checked} geprüft.`);
          }
        } catch (e) {
          if (e.message === '__cancel') throw e;
          job.rulesResult = { error: e.message };
          addLog(`✗ Regeln konnten nicht angewendet werden: ${e.message}`);
        }
      }
      job.status = 'done';
      job.current = null;
      job.finishedAt = new Date().toISOString();
      setPhase('Fertig.');
      addLog(job.kind === 'quick' ? 'Neue Aktivitäten geholt.' : 'Import abgeschlossen.');
    } catch (e) {
      if (e.message === '__cancel') {
        job.status = 'cancelled';
        setPhase('Abgebrochen. Mit „Fortsetzen“ geht es beim nächsten offenen Abschnitt weiter.');
        addLog('Vom Benutzer abgebrochen.');
      } else {
        job.status = 'paused';
        setPhase(e.message);
        addLog(`Angehalten: ${e.message}`);
      }
    } finally {
      job.cancel = false;
      job.nextAt = null;
      if (job.kind === 'quick') { quick.lastRunAt = new Date().toISOString(); saveQuick(); }
      save();
      runner = null;
    }
  }

  function newJob(session, { startDate, endDate, order, applyRules: withRules, kind }) {
    tokens = { accessToken: session.accessToken, refreshToken: session.refreshToken };
    job = {
      createdAt: new Date().toISOString(),
      konto: session.email,
      kind,
      startDate,
      endDate,
      order,
      applyRules: !!withRules,
      chunks: makeChunks(startDate, endDate, order),
      totals: { imported: 0, matched: 0, skipped: 0, needsReview: 0, failed: 0 },
      rulesResult: null,
      log: [],
      status: 'running',
      phase: 'Startet …',
      nextAt: null,
      current: null,
    };
  }

  return {
    state() {
      return job ? { ...job, cancel: undefined } : null;
    },
    quickInfo() {
      return { lastEnd: quick.lastEnd || null, lastRunAt: quick.lastRunAt || null, running: !!runner };
    },
    // Neue Aktivitäten seit dem letzten Import holen und danach die Regeln anwenden
    quick(session, { auto } = {}) {
      if (runner) {
        if (auto) return { skipped: 'läuft schon', job: this.state() };
        throw new Error('Es läuft bereits ein Import.');
      }
      if (job && job.kind !== 'quick' && job.chunks.some((c) => c.status === 'pending')) {
        if (auto) return { skipped: 'Verlauf-Import offen', job: this.state() };
        throw new Error('Es gibt einen unfertigen Verlauf-Import. Bitte erst fortsetzen oder unter „Garmin-Import“ löschen.');
      }
      if (auto && quick.lastRunAt && Date.now() - Date.parse(quick.lastRunAt) < AUTO_MIN_GAP_MS) {
        return { skipped: 'vor kurzem geholt', job: this.state() };
      }
      const endDate = todayUtc();
      // einen Tag Überlappung, damit Aktivitäten rund um Mitternacht nicht fehlen
      let startDate = quick.lastEnd
        ? isoDay(parseDay(quick.lastEnd) - DAY)
        : isoDay(parseDay(endDate) - (QUICK_DAYS - 1) * DAY);
      if (startDate > endDate) startDate = endDate;
      newJob(session, { startDate, endDate, order: 'asc', applyRules: true, kind: 'quick' });
      addLog(`Neue Aktivitäten holen: ${startDate} bis ${endDate}${job.chunks.length > 1 ? ` (${job.chunks.length} Abschnitte)` : ''}.`);
      runner = run();
      return { started: true, job: this.state() };
    },
    start(session, { startDate, endDate, order, applyRules: withRules }) {
      if (runner) throw new Error('Es läuft bereits ein Import.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) {
        throw new Error('Bitte Von- und Bis-Datum angeben.');
      }
      if (endDate > todayUtc()) endDate = todayUtc();
      if (startDate > endDate) throw new Error('Das Von-Datum liegt nach dem Bis-Datum.');
      newJob(session, { startDate, endDate, order: order === 'asc' ? 'asc' : 'desc', applyRules: withRules, kind: 'history' });
      addLog(`Import ${startDate} bis ${endDate} in ${job.chunks.length} Abschnitten gestartet.`);
      runner = run();
      return this.state();
    },
    resume(session) {
      if (runner) throw new Error('Der Import läuft bereits.');
      if (!job || !job.chunks.some((c) => c.status === 'pending')) throw new Error('Kein offener Import vorhanden.');
      tokens = { accessToken: session.accessToken, refreshToken: session.refreshToken };
      addLog('Fortgesetzt.');
      runner = run();
      return this.state();
    },
    retryFailed(session) {
      if (runner) throw new Error('Der Import läuft bereits.');
      if (!job) throw new Error('Kein Import vorhanden.');
      let n = 0;
      for (const c of job.chunks) if (c.status === 'failed') { c.status = 'pending'; delete c.error; n++; }
      if (!n) throw new Error('Keine fehlgeschlagenen Abschnitte.');
      return this.resume(session);
    },
    cancel() {
      if (!runner) throw new Error('Es läuft kein Import.');
      job.cancel = true;
      save();
      return this.state();
    },
    clear() {
      if (runner) throw new Error('Erst abbrechen, dann löschen.');
      job = null;
      try { fs.unlinkSync(stateFile); } catch { /* egal */ }
      return null;
    },
  };
}

module.exports = { createImporter, makeChunks };
