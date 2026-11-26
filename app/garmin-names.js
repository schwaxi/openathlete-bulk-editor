'use strict';
// Namen aus Garmin übernehmen
//
// OpenAthlete übernimmt den Namen einer Garmin-Aktivität nur beim ersten Import.
// Dieses Modul fragt Garmins Aktivitätsliste direkt ab (mit dem Personal API Key,
// den OpenAthlete verschlüsselt speichert und nicht herausgibt), ordnet die
// Aktivitäten über die Startzeit zu und setzt den Garmin-Namen in OpenAthlete.
//
// Damit Umbenennungen in OpenAthlete nicht zurückgedreht werden, merkt sich der
// Editor pro Garmin-Aktivität den Namen vom letzten Abgleich:
//  - Garmin-Name hat sich seitdem geändert  → Garmin gewinnt
//  - Garmin-Name gleich, OpenAthlete anders → in OpenAthlete umbenannt, bleibt
//  - noch nie abgeglichen                   → Garmin gewinnt, außer der Editor
//    hat die Aktivität laut Protokoll selbst umbenannt
const fs = require('node:fs');
const path = require('node:path');

const GARMIN = process.env.GARMIN_PERSONAL_URL || 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
const LIST_PATH = '/activitylist-service/activities/search/activities';
const DAY = 86400000;
const MATCH_MS = 120000; // Startzeit darf so weit abweichen
const WINDOW_DAYS = 90; // Garmin-Liste in Abschnitten abfragen
const GAP_MS = Number(process.env.GARMIN_NAMES_GAP_MS || 300);
// Endungen der geteilten Multisport-Teile (siehe fit.js)
const PART_RE = /^(.*) – ((?:Schwimmen|Rad|Laufen|Sport)(?: \d+)?|Wechsel \d+)$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim();

class GarminError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function createNameSync({ dataDir, authed, apiError, logChange, logFile }) {
  const keyFile = path.join(dataDir, 'garmin-key.json');
  const stateFile = path.join(dataDir, 'garmin-namen.json');
  let state = { autoEnabled: true, autoDays: 30, seen: {} };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { /* neu */ }
  let apiKey = null;
  try { apiKey = JSON.parse(fs.readFileSync(keyFile, 'utf8')).apiKey || null; } catch { /* keiner */ }
  let garminToken = null; // { token, expiresAt }
  let job = null;
  let runner = null;

  const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(state));

  // --- Garmin ----------------------------------------------------------------
  async function garminFetch(method, urlPath, authorization, params) {
    const url = new URL(GARMIN + urlPath);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: authorization, Accept: '*/*' },
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new GarminError('unavailable', `Garmin nicht erreichbar (${e.message})`);
    }
    const text = await res.text();
    if (res.ok) return text;
    if (res.status === 401 || (res.status === 403 && urlPath === TOKEN_PATH)) {
      throw new GarminError('key', 'Garmin lehnt den API Key ab. Bitte den Key prüfen.');
    }
    if (res.status === 403) throw new GarminError('denied', 'Garmin verweigert den Zugriff (403).');
    if (res.status === 429) throw new GarminError('rate', 'Garmin meldet zu viele Anfragen (429).');
    throw new GarminError('unavailable', `Garmin antwortet mit Fehler ${res.status}.`);
  }

  async function authorize(key) {
    const text = (await garminFetch('POST', TOKEN_PATH, `ApiKey ${key}`)).trim();
    const parts = text.split('.');
    let exp = 0;
    try { exp = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).exp; } catch { /* unten */ }
    if (parts.length !== 3 || !exp) throw new GarminError('invalid', 'Unerwartete Antwort von Garmin beim Anmelden.');
    return { token: text, expiresAt: Math.min(exp * 1000, Date.now() + DAY) };
  }

  async function garminGet(urlPath, params) {
    if (!apiKey) throw new GarminError('key', 'Kein Garmin API Key gespeichert.');
    for (let attempt = 0; ; attempt++) {
      if (!garminToken || garminToken.expiresAt < Date.now() + 60000) garminToken = await authorize(apiKey);
      try {
        const text = await garminFetch('GET', urlPath, `Bearer ${garminToken.token}`, params);
        return text ? JSON.parse(text) : null;
      } catch (e) {
        if (e.code === 'key' && attempt === 0) { garminToken = null; continue; }
        if (e.code === 'rate' && attempt < 5) {
          if (job) job.phase = 'Garmin bremst (zu viele Anfragen), warte eine Minute …';
          await sleep(60000);
          continue;
        }
        if (e instanceof SyntaxError) throw new GarminError('invalid', 'Unerwartete Antwort von Garmin.');
        throw e;
      }
    }
  }

  function normalize(a) {
    let start = null;
    if (Number.isFinite(a.beginTimestamp)) start = a.beginTimestamp;
    else if (typeof a.startTimeGMT === 'string') start = Date.parse(a.startTimeGMT.replace(' ', 'T') + 'Z');
    const dur = Number(a.elapsedDuration ?? a.duration ?? 0);
    return {
      id: String(a.activityId),
      name: cleanName(a.activityName).slice(0, 100),
      start: Number.isFinite(start) ? start : null,
      end: Number.isFinite(start) ? start + (dur > 0 ? dur * 1000 : 0) : null,
      multisport: (a.activityType && a.activityType.typeKey === 'multi_sport') || a.isMultiSportParent === true,
    };
  }

  async function garminList(fromMs, toMs, onProgress) {
    const out = [];
    let withoutStart = 0;
    for (let w = fromMs; w <= toMs; w += WINDOW_DAYS * DAY) {
      const wEnd = Math.min(w + (WINDOW_DAYS - 1) * DAY, toMs);
      for (let start = 0; start < 5000; start += 100) {
        checkCancel();
        const data = await garminGet(LIST_PATH, {
          start, limit: 100, startDate: isoDay(w), endDate: isoDay(wEnd), sortOrder: 'asc', excludeChildren: 'true',
        });
        if (!Array.isArray(data)) throw new GarminError('invalid', 'Unerwartete Antwort von Garmin (keine Liste).');
        for (const a of data) {
          if (!a || a.activityId == null) continue;
          const g = normalize(a);
          if (g.start == null) withoutStart++;
          else out.push(g);
        }
        if (onProgress) onProgress(Math.min(1, (wEnd - fromMs + DAY) / (toMs - fromMs + DAY)), out.length);
        await sleep(GAP_MS);
        if (data.length < 100) break;
      }
    }
    if (withoutStart && !out.length) throw new GarminError('invalid', 'Garmin liefert keine Startzeiten, ein Abgleich ist so nicht möglich.');
    return out.sort((a, b) => a.start - b.start);
  }

  // --- Zuordnung ---------------------------------------------------------------
  // Aktivitäten, die der Editor selbst umbenannt hat (aus dem Änderungsprotokoll)
  function editorRenamed() {
    const set = new Set();
    let text = '';
    try { text = fs.readFileSync(logFile, 'utf8'); } catch { return set; }
    for (const line of text.split('\n')) {
      if (!line.includes('"name"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.ok && e.nachher && typeof e.nachher.name === 'string' && e.konto !== 'Name aus Garmin') set.add(e.eventId);
        if (e.ok && e.konto === 'Name aus Garmin') set.delete(e.eventId);
      } catch { /* kaputte Zeile */ }
    }
    return set;
  }

  // Liefert pro OpenAthlete-Aktivität den passenden Garmin-Namen und ob er übernommen wird
  function compare(activities, garmin) {
    const renamed = editorRenamed();
    const diffs = [];
    const seenUpdates = {};
    let matched = 0;
    let same = 0;
    const nearest = (t) => {
      let best = null;
      let lo = 0;
      let hi = garmin.length - 1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (garmin[mid].start < t) lo = mid + 1; else hi = mid - 1; }
      for (const i of [lo - 1, lo]) {
        const g = garmin[i];
        if (g && Math.abs(g.start - t) <= MATCH_MS && (!best || Math.abs(g.start - t) < Math.abs(best.start - t))) best = g;
      }
      return best;
    };
    const containing = (t) => {
      // Multisport-Eltern, in deren Zeitraum der Start liegt (der späteste Start davor)
      let best = null;
      for (const g of garmin) {
        if (g.start - MATCH_MS > t) break;
        if (g.multisport && g.end != null && t <= g.end + MATCH_MS) best = g;
      }
      return best;
    };
    for (const a of activities) {
      const t = Date.parse(a.startDate);
      if (!Number.isFinite(t)) continue;
      const part = PART_RE.exec(a.name || '');
      let g = nearest(t);
      let suffix = null;
      if (part && (!g || g.multisport)) {
        const p = g && g.multisport ? g : containing(t);
        if (p) { g = p; suffix = part[2]; }
      }
      if (!g || !g.name) continue;
      matched++;
      const want = suffix ? `${g.name.slice(0, 85)} – ${suffix}` : g.name;
      seenUpdates[g.id] = g.name;
      if (want === cleanName(a.name)) { same++; continue; }
      const prev = state.seen[g.id];
      let kind;
      if (prev !== undefined) kind = prev === g.name ? 'local' : 'garmin';
      else kind = renamed.has(a.eventId) ? 'local' : 'garmin';
      diffs.push({ eventId: a.eventId, date: (a.startDate || '').slice(0, 10), current: a.name, garmin: want, garminId: g.id, kind });
    }
    diffs.sort((x, y) => (x.date < y.date ? 1 : -1));
    return { diffs, seenUpdates, matched, same };
  }

  async function loadActivities(tokens, fromMs, toMs) {
    const from = new Date(fromMs - DAY).toISOString();
    const to = new Date(toMs + 2 * DAY).toISOString();
    const r = await authed(tokens, 'GET', `/event?startDate=${encodeURIComponent(from)}&endDate=${encodeURIComponent(to)}`);
    if (!r.ok) throw new Error(`Aktivitäten nicht abrufbar: ${apiError(r)}`);
    return (Array.isArray(r.data) ? r.data : []).filter((e) => e.type === 'ACTIVITY');
  }

  async function rename(tokens, d) {
    const res = await authed(tokens, 'PATCH', `/event/${d.eventId}`, { type: 'ACTIVITY', name: d.garmin });
    logChange({
      konto: 'Name aus Garmin',
      eventId: d.eventId,
      vorher: { name: d.current },
      nachher: { type: 'ACTIVITY', name: d.garmin },
      ok: res.ok,
      fehler: res.ok ? undefined : apiError(res),
    });
    return res.ok ? null : apiError(res);
  }

  function checkCancel() {
    if (job && job.cancel) throw new Error('__cancel');
  }

  // --- Abgleich mit Vorschau (ganzer Bestand oder Zeitraum) -------------------
  async function runPreview(tokens) {
    try {
      const fromMs = job.from ? Date.parse(`${job.from}T00:00:00Z`) : null;
      const toMs = Date.parse(`${job.to}T00:00:00Z`);
      job.phase = 'Lade Aktivitäten aus OpenAthlete …';
      const acts = await loadActivities(tokens, fromMs ?? Date.parse('2000-01-01T00:00:00Z'), toMs);
      if (!acts.length) {
        Object.assign(job, { status: 'ready', phase: 'Keine Aktivitäten im Zeitraum.', diffs: [], stats: { activities: 0, garmin: 0, matched: 0, same: 0 } });
        return;
      }
      // ohne Startdatum: ab der ältesten Aktivität in OpenAthlete
      const oldest = Math.min(...acts.map((a) => Date.parse(a.startDate)).filter(Number.isFinite));
      const gFrom = fromMs ?? Date.parse(`${isoDay(oldest - DAY)}T00:00:00Z`);
      job.phase = 'Lade Aktivitätsliste von Garmin …';
      const garmin = await garminList(gFrom, toMs, (p, n) => {
        job.progress = p;
        job.phase = `Lade Aktivitätsliste von Garmin … ${n} Aktivitäten`;
      });
      const inRange = acts.filter((a) => {
        const t = Date.parse(a.startDate);
        return t >= gFrom - DAY && t < toMs + 2 * DAY;
      });
      const r = compare(inRange, garmin);
      job.diffs = r.diffs;
      job.seenUpdates = r.seenUpdates;
      job.stats = { activities: inRange.length, garmin: garmin.length, matched: r.matched, same: r.same };
      job.status = 'ready';
      job.progress = 1;
      job.phase = r.diffs.length ? 'Unterschiede gefunden. Auswählen und übernehmen.' : 'Alle Namen stimmen mit Garmin überein.';
      if (!r.diffs.length) { Object.assign(state.seen, r.seenUpdates); saveState(); }
    } catch (e) {
      job.status = e.message === '__cancel' ? 'cancelled' : 'failed';
      job.phase = e.message === '__cancel' ? 'Abgebrochen.' : e.message;
    } finally {
      job.cancel = false;
      runner = null;
    }
  }

  async function runApply(tokens, ids) {
    try {
      const chosen = job.diffs.filter((d) => ids.has(d.eventId));
      job.applied = 0;
      job.failed = [];
      let i = 0;
      for (const d of chosen) {
        checkCancel();
        job.phase = `Übernehme Namen … ${++i} von ${chosen.length}`;
        job.progress = i / chosen.length;
        const err = await rename(tokens, d);
        if (err) job.failed.push({ ...d, error: err });
        else { job.applied++; d.done = true; }
      }
      // alle gesehenen Garmin-Namen merken: nicht übernommene gelten ab jetzt als
      // „in OpenAthlete umbenannt“ und bleiben, bis sie sich in Garmin ändern
      Object.assign(state.seen, job.seenUpdates);
      saveState();
      job.status = 'done';
      job.phase = `${job.applied} Namen übernommen${job.failed.length ? `, ${job.failed.length} fehlgeschlagen` : ''}.`;
    } catch (e) {
      job.status = e.message === '__cancel' ? 'cancelled' : 'failed';
      job.phase = e.message === '__cancel' ? `Abgebrochen nach ${job.applied} Namen.` : e.message;
    } finally {
      job.cancel = false;
      runner = null;
    }
  }

  function publicJob() {
    if (!job) return null;
    return {
      status: job.status, phase: job.phase, progress: job.progress || 0, from: job.from, to: job.to,
      stats: job.stats || null, diffs: job.diffs || [], applied: job.applied ?? null, failed: job.failed || [],
    };
  }

  return {
    status() {
      return {
        keySet: !!apiKey,
        keyHint: apiKey ? `…${apiKey.slice(-4)}` : null,
        autoEnabled: state.autoEnabled !== false,
        autoDays: state.autoDays || 30,
        lastAuto: state.lastAuto || null,
        known: Object.keys(state.seen).length,
        job: publicJob(),
      };
    },

    async saveSettings({ key, autoEnabled, autoDays }) {
      if (typeof key === 'string') {
        const k = key.trim();
        if (!k) {
          apiKey = null;
          garminToken = null;
          fs.rmSync(keyFile, { force: true });
        } else {
          if (k.length > 4000 || /\s/.test(k)) throw new Error('Das sieht nicht nach einem API Key aus.');
          garminToken = await authorize(k); // prüft den Key sofort
          apiKey = k;
          fs.writeFileSync(keyFile, JSON.stringify({ apiKey: k }), { mode: 0o600 });
        }
      }
      if (typeof autoEnabled === 'boolean') state.autoEnabled = autoEnabled;
      if (Number.isInteger(autoDays) && autoDays >= 1 && autoDays <= 365) state.autoDays = autoDays;
      saveState();
      return this.status();
    },

    preview(session, { from, to } = {}) {
      if (runner) throw new Error('Es läuft bereits ein Abgleich.');
      if (!apiKey) throw new Error('Bitte zuerst den Garmin API Key speichern.');
      const re = /^\d{4}-\d{2}-\d{2}$/;
      const toDay = re.test(to || '') ? to : isoDay(Date.now());
      const fromDay = re.test(from || '') ? from : null;
      if (fromDay && fromDay > toDay) throw new Error('„Von“ liegt nach „Bis“.');
      const tokens = { accessToken: session.accessToken, refreshToken: session.refreshToken };
      job = { status: 'running', phase: 'Starte …', from: fromDay, to: toDay, progress: 0, cancel: false };
      runner = runPreview(tokens);
      return publicJob();
    },

    apply(session, { eventIds }) {
      if (runner) throw new Error('Es läuft bereits ein Abgleich.');
      if (!job || job.status !== 'ready') throw new Error('Bitte zuerst „Unterschiede suchen“.');
      if (!Array.isArray(eventIds)) throw new Error('Liste erwartet');
      const tokens = { accessToken: session.accessToken, refreshToken: session.refreshToken };
      job.status = 'applying';
      job.progress = 0;
      runner = runApply(tokens, new Set(eventIds.map(Number)));
      return publicJob();
    },

    cancel() {
      if (job && runner) job.cancel = true;
      return publicJob();
    },

    // Automatisch nach „Neue Aktivitäten holen“: nur Änderungen aus Garmin übernehmen
    async auto(tokens) {
      if (!apiKey) return { disabled: 'Kein Garmin API Key im Editor gespeichert.' };
      if (state.autoEnabled === false) return { disabled: 'Namensabgleich beim Holen ist ausgeschaltet.' };
      if (runner) return { disabled: 'Ein anderer Namensabgleich läuft gerade.' };
      const toMs = Date.parse(`${isoDay(Date.now())}T00:00:00Z`);
      const fromMs = toMs - ((state.autoDays || 30) - 1) * DAY;
      const garmin = await garminList(fromMs, toMs);
      const acts = await loadActivities(tokens, fromMs, toMs);
      const r = compare(acts, garmin);
      const changed = [];
      const failed = [];
      let kept = 0;
      for (const d of r.diffs) {
        if (d.kind !== 'garmin') { kept++; continue; }
        const err = await rename(tokens, d);
        if (err) failed.push({ ...d, error: err });
        else changed.push(d);
      }
      Object.assign(state.seen, r.seenUpdates);
      state.lastAuto = { at: new Date().toISOString(), changed: changed.length, kept, failed: failed.length };
      saveState();
      return { checked: acts.length, garmin: garmin.length, changed, kept, failed, days: state.autoDays || 30 };
    },
  };
}

module.exports = { createNameSync, PART_RE };
