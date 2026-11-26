// OpenAthlete Masseneditor
// Kleiner Server ohne Zusatzpakete (nur Node.js >= 18). Er meldet sich mit
// deinem OpenAthlete-Konto an der offiziellen API an und ändert Aktivitäten
// über dieselbe Schnittstelle wie die App selbst (PATCH /event/:id).
// Dadurch berechnet OpenAthlete nach einer Sportart-Änderung Rekorde und
// Belastung selbst neu.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8080);
const API = (process.env.OA_API_URL || 'http://api:3000').replace(/\/+$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const RULES_FILE = path.join(DATA_DIR, 'regeln.json');
const LOG_FILE = path.join(DATA_DIR, 'aenderungen.log');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Sitzungen (nur im Speicher; nach Neustart des Containers neu anmelden)
// ---------------------------------------------------------------------------
const sessions = new Map(); // sid -> { accessToken, refreshToken, email, lastUsed }
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.lastUsed > SESSION_IDLE_MS) sessions.delete(sid);
  }
}, 60 * 60 * 1000).unref();

function getSession(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)oaed_sid=([a-f0-9]{64})/);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s) return null;
  s.lastUsed = Date.now();
  s.sid = m[1];
  return s;
}

// ---------------------------------------------------------------------------
// Aufrufe an die OpenAthlete-API
// ---------------------------------------------------------------------------
async function apiFetch(method, urlPath, { body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + urlPath, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text.slice(0, 300) };
  }
  return { status: res.status, ok: res.ok, data };
}

async function refresh(session) {
  const r = await apiFetch('POST', '/auth/refresh-token', {
    body: { refreshToken: session.refreshToken },
  });
  if (!r.ok || !r.data || !r.data.accessToken) return false;
  session.accessToken = r.data.accessToken;
  if (r.data.refreshToken) session.refreshToken = r.data.refreshToken;
  return true;
}

// API-Aufruf mit Anmeldung; bei abgelaufenem Token einmal erneuern
async function authed(session, method, urlPath, body) {
  let r = await apiFetch(method, urlPath, { body, token: session.accessToken });
  if (r.status === 401 && (await refresh(session))) {
    r = await apiFetch(method, urlPath, { body, token: session.accessToken });
  }
  return r;
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------
function send(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Anfrage zu groß'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Ungültiges JSON'));
      }
    });
    req.on('error', reject);
  });
}

function apiError(r) {
  const msg =
    (r.data && (r.data.message || r.data.error)) ||
    `OpenAthlete antwortete mit Status ${r.status}`;
  return Array.isArray(msg) ? msg.join(', ') : String(msg);
}

function logChange(entry) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify({ zeit: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.error('Protokoll konnte nicht geschrieben werden:', e.message);
  }
}

function slimActivity(e) {
  return {
    eventId: e.eventId,
    name: e.name,
    startDate: e.startDate,
    sport: e.sport,
    distance: e.distance ?? null,
    movingTime: e.movingTime ?? null,
    elevationGain: e.elevationGain ?? null,
    equipmentId: e.equipmentId ?? null,
    equipmentName: e.equipment ? e.equipment.name : null,
    provider: e.provider ?? null,
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Nicht gefunden');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

function readRules() {
  try {
    const r = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

// Gespeicherte Regeln auf alle Aktivitäten im Zeitraum anwenden (nach einem Garmin-Import)
const { planRules } = require('./public/rules.js');
async function applyRulesInRange(tokens, startDate, endDate) {
  const rules = readRules().filter((r) => r && typeof r.keyword === 'string' && r.keyword.trim());
  if (!rules.length) return { noRules: true, checked: 0, changed: [], failed: [] };
  // je einen Tag Puffer wegen Zeitzonen; die Regeln ändern nur, was abweicht
  const from = new Date(Date.parse(`${startDate}T00:00:00Z`) - 86400000).toISOString();
  const to = new Date(Date.parse(`${endDate}T23:59:59Z`) + 86400000).toISOString();
  const r = await authed(tokens, 'GET', `/event?startDate=${encodeURIComponent(from)}&endDate=${encodeURIComponent(to)}`);
  if (!r.ok) throw new Error(`Aktivitäten nicht abrufbar: ${apiError(r)}`);
  const list = (Array.isArray(r.data) ? r.data : []).filter((e) => e.type === 'ACTIVITY').map(slimActivity);
  const plan = planRules(rules, list);
  const changed = [];
  const failed = [];
  let equipNames = null;
  for (const [eventId, ch] of plan) {
    const a = list.find((x) => x.eventId === eventId);
    const date = (a.startDate || '').slice(0, 10);
    const res = await authed(tokens, 'PATCH', `/event/${eventId}`, { type: 'ACTIVITY', ...ch });
    logChange({
      konto: 'Regeln nach Garmin-Import',
      eventId,
      vorher: { name: a.name, sport: a.sport, equipmentId: a.equipmentId },
      nachher: { type: 'ACTIVITY', ...ch },
      ok: res.ok,
      fehler: res.ok ? undefined : apiError(res),
    });
    if (!res.ok) {
      failed.push({ eventId, name: a.name, date, error: apiError(res) });
      continue;
    }
    const parts = [];
    if (ch.sport) parts.push(`Sportart ${ch.sport}`);
    if ('equipmentId' in ch) {
      if (!equipNames) {
        const eq = await authed(tokens, 'GET', '/equipment');
        equipNames = new Map((eq.ok && Array.isArray(eq.data) ? eq.data : []).map((e) => [e.equipmentId, e.name]));
      }
      parts.push(ch.equipmentId == null ? 'keine Ausrüstung' : `Ausrüstung ${equipNames.get(ch.equipmentId) || `#${ch.equipmentId}`}`);
    }
    changed.push({ eventId, name: a.name, date, text: parts.join(', ') });
  }
  return { noRules: false, checked: list.length, changed, failed };
}

// Aktivitätsdatei an OpenAthlete hochladen (wie der Datei-Upload in der App)
async function uploadActivityFile(tokens, kind, buffer, filename, name) {
  const send = async () => {
    const form = new FormData();
    form.append('name', name);
    form.append('file', new Blob([buffer], { type: 'application/octet-stream' }), filename);
    const res = await fetch(`${API}/activity-import/${kind}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'application/json' },
      body: form,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 300) }; }
    return { status: res.status, ok: res.ok, data };
  };
  let r = await send();
  if (r.status === 401 && (await refresh(tokens))) r = await send();
  return r;
}

const { createExportImporter } = require('./export-import');
const exportImporter = createExportImporter({ dataDir: DATA_DIR, upload: uploadActivityFile, applyRules: applyRulesInRange });

function exportBusy() {
  const j = exportImporter.state();
  return !!j && (j.status === 'running' || j.status === 'scanning');
}
function safeImportName(raw) {
  const base = path.basename(String(raw || '')).replace(/[^\w.\- ()äöüÄÖÜß]/g, '_').trim();
  if (!base || base.startsWith('.') || base.length > 150) return null;
  return /\.(zip|fit|gpx|tcx)$/i.test(base) ? base : null;
}
function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

const { createImporter } = require('./garmin-import');
const importer = createImporter({ authed, dataDir: DATA_DIR, apiError, applyRules: applyRulesInRange });

// ---------------------------------------------------------------------------
// Routen
// ---------------------------------------------------------------------------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (!p.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    return serveStatic(req, res, p);
  }

  // Nur gleiche Herkunft für schreibende Aufrufe (Schutz gegen fremde Seiten)
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) {
      return send(res, 403, { error: 'Fremde Herkunft abgelehnt' });
    }
  }

  // --- Anmeldung -----------------------------------------------------------
  if (p === '/api/login' && req.method === 'POST') {
    const { email, password } = await readBody(req);
    if (!email || !password) return send(res, 400, { error: 'E-Mail und Passwort angeben' });
    let r;
    try {
      r = await apiFetch('POST', '/auth/login', { body: { email, password } });
    } catch (e) {
      return send(res, 502, {
        error: `OpenAthlete-API nicht erreichbar (${API}): ${e.message}`,
      });
    }
    if (!r.ok || !r.data || !r.data.accessToken) {
      return send(res, r.status === 401 ? 401 : 502, {
        error: r.status === 401 ? 'E-Mail oder Passwort falsch' : apiError(r),
      });
    }
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, {
      accessToken: r.data.accessToken,
      refreshToken: r.data.refreshToken,
      email,
      lastUsed: Date.now(),
    });
    return send(res, 200, { ok: true, email }, {
      'Set-Cookie': `oaed_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_IDLE_MS / 1000}`,
    });
  }

  if (p === '/api/logout' && req.method === 'POST') {
    const s = getSession(req);
    if (s) sessions.delete(s.sid);
    return send(res, 200, { ok: true }, {
      'Set-Cookie': 'oaed_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    });
  }

  const session = getSession(req);
  if (p === '/api/me') {
    return send(res, 200, session ? { loggedIn: true, email: session.email } : { loggedIn: false });
  }
  if (!session) return send(res, 401, { error: 'Bitte anmelden' });

  // --- Aktivitäten laden ---------------------------------------------------
  if (p === '/api/activities' && req.method === 'GET') {
    const qs = new URLSearchParams();
    if (url.searchParams.get('from')) qs.set('startDate', new Date(url.searchParams.get('from')).toISOString());
    if (url.searchParams.get('to')) {
      const to = new Date(url.searchParams.get('to'));
      to.setHours(23, 59, 59, 999);
      qs.set('endDate', to.toISOString());
    }
    const r = await authed(session, 'GET', '/event' + (qs.toString() ? `?${qs}` : ''));
    if (!r.ok) return send(res, r.status, { error: apiError(r) });
    const list = (Array.isArray(r.data) ? r.data : [])
      .filter((e) => e.type === 'ACTIVITY')
      .map(slimActivity)
      .sort((a, b) => new Date(b.startDate) - new Date(a.startDate));
    return send(res, 200, list);
  }

  // --- Ausrüstung ----------------------------------------------------------
  if (p === '/api/equipment' && req.method === 'GET') {
    const r = await authed(session, 'GET', '/equipment');
    if (!r.ok) return send(res, r.status, { error: apiError(r) });
    return send(res, 200, r.data);
  }

  // --- Eine Aktivität ändern -----------------------------------------------
  const m = p.match(/^\/api\/activities\/(\d+)$/);
  if (m && req.method === 'PATCH') {
    const eventId = Number(m[1]);
    const input = await readBody(req);
    // type: 'ACTIVITY' ist wichtig: sonst würde die API Felder wie
    // equipmentId stillschweigend verwerfen.
    const body = { type: 'ACTIVITY' };
    if (typeof input.name === 'string') {
      const name = input.name.trim();
      if (name.length < 1 || name.length > 100) {
        return send(res, 400, { error: 'Name muss 1 bis 100 Zeichen lang sein' });
      }
      body.name = name;
    }
    if (typeof input.sport === 'string') body.sport = input.sport;
    if (input.equipmentId === null || Number.isInteger(input.equipmentId)) {
      body.equipmentId = input.equipmentId;
    }
    if (Object.keys(body).length === 1) return send(res, 400, { error: 'Nichts zu ändern' });

    const r = await authed(session, 'PATCH', `/event/${eventId}`, body);
    logChange({
      konto: session.email,
      eventId,
      vorher: input.before || null,
      nachher: body,
      ok: r.ok,
      fehler: r.ok ? undefined : apiError(r),
    });
    if (!r.ok) return send(res, r.status, { error: apiError(r) });
    return send(res, 200, slimActivity(r.data || {}));
  }

  // --- Garmin-Verlauf-Import -----------------------------------------------
  if (p === '/api/garmin/status' && req.method === 'GET') {
    const r = await authed(session, 'GET', '/provider/garmin-personal');
    return send(res, 200, {
      connection: r.ok ? r.data : null,
      connectionError: r.ok ? null : apiError(r),
      job: importer.state(),
      quick: importer.quickInfo(),
    });
  }
  if (p === '/api/garmin/quick' && req.method === 'POST') {
    try {
      const { auto } = await readBody(req);
      return send(res, 200, importer.quick(session, { auto: auto === true }));
    } catch (e) {
      return send(res, 409, { error: e.message });
    }
  }
  const gm = p.match(/^\/api\/garmin\/import(?:\/(cancel|resume|retry|clear))?$/);
  if (gm && req.method === 'POST') {
    try {
      const action = gm[1];
      if (!action) return send(res, 200, importer.start(session, await readBody(req)));
      if (action === 'cancel') return send(res, 200, importer.cancel());
      if (action === 'resume') return send(res, 200, importer.resume(session));
      if (action === 'retry') return send(res, 200, importer.retryFailed(session));
      return send(res, 200, importer.clear());
    } catch (e) {
      return send(res, 409, { error: e.message });
    }
  }

  // --- Garmin-Export (ZIP aus „Daten exportieren“) --------------------------
  if (p === '/api/export/status' && req.method === 'GET') {
    return send(res, 200, { sources: exportImporter.sources(), job: exportImporter.state() });
  }
  // Datei aus dem Browser in den Import-Ordner hochladen (roh, ohne Formular, damit
  // auch eine 600-MB-ZIP gestreamt statt in den Speicher gelesen wird)
  if (p === '/api/export/upload' && req.method === 'PUT') {
    const name = safeImportName(url.searchParams.get('name'));
    if (!name) return send(res, 400, { error: 'Nur .zip, .fit, .gpx oder .tcx erlaubt' });
    if (exportBusy()) return send(res, 409, { error: 'Während eines Imports kann nichts hochgeladen werden.' });
    const size = Number(req.headers['content-length']);
    const free = freeBytes(exportImporter.importDir);
    if (size && free != null && size + 200e6 > free) {
      return send(res, 507, { error: `Zu wenig Speicherplatz frei (${Math.round(free / 1e6)} MB frei, nötig etwa ${Math.round((size + 200e6) / 1e6)} MB).` });
    }
    const target = path.join(exportImporter.importDir, name);
    const part = `${target}.part`;
    try {
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(part);
        let got = 0;
        req.on('data', (c) => { got += c.length; });
        req.on('aborted', () => reject(new Error('Upload abgebrochen')));
        out.on('error', reject);
        out.on('finish', () => (size && got !== size ? reject(new Error('Upload unvollständig')) : resolve()));
        req.pipe(out);
      });
      fs.renameSync(part, target);
    } catch (e) {
      try { fs.rmSync(part, { force: true }); } catch { /* egal */ }
      if (!res.headersSent && !req.destroyed) return send(res, 400, { error: e.message });
      return undefined;
    }
    return send(res, 200, { ok: true, name, sources: exportImporter.sources() });
  }
  if (p === '/api/export/file' && req.method === 'DELETE') {
    const name = url.searchParams.get('name') || '';
    const entry = exportImporter.sources().find((s) => s.name === name && !s.dir);
    if (!entry) return send(res, 404, { error: 'Datei nicht gefunden' });
    if (exportBusy()) return send(res, 409, { error: 'Während eines Imports kann nichts gelöscht werden.' });
    fs.rmSync(path.join(exportImporter.importDir, entry.name), { force: true });
    return send(res, 200, { ok: true, sources: exportImporter.sources() });
  }
  const em = p.match(/^\/api\/export\/(scan|start|cancel|resume|retry|clear)$/);
  if (em && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const a = em[1];
      if (a === 'scan') return send(res, 200, exportImporter.scan(session, body));
      if (a === 'start') return send(res, 200, exportImporter.start(session, body));
      if (a === 'cancel') return send(res, 200, exportImporter.cancel());
      if (a === 'resume') return send(res, 200, exportImporter.resume(session));
      if (a === 'retry') return send(res, 200, exportImporter.retryFailed(session));
      return send(res, 200, exportImporter.clear());
    } catch (e) {
      return send(res, 409, { error: e.message });
    }
  }

  // --- Regeln (gespeichert in /data/regeln.json) ---------------------------
  if (p === '/api/rules' && req.method === 'GET') {
    return send(res, 200, readRules());
  }
  if (p === '/api/rules' && req.method === 'PUT') {
    const rules = await readBody(req);
    if (!Array.isArray(rules)) return send(res, 400, { error: 'Liste erwartet' });
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Unbekannter Pfad' });
}

const server = http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: e.message || 'Interner Fehler' });
    });
  })
  .listen(PORT, () => {
    console.log(`OpenAthlete Masseneditor läuft auf Port ${PORT}, API: ${API}`);
  });
// große Uploads (Garmin-Export) dürfen länger als die Standard-5-Minuten dauern
server.requestTimeout = 0;
