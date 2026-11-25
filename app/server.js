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

const { createImporter } = require('./garmin-import');
const importer = createImporter({ authed, dataDir: DATA_DIR, apiError });

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
    });
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

  // --- Regeln (gespeichert in /data/regeln.json) ---------------------------
  if (p === '/api/rules' && req.method === 'GET') {
    try {
      return send(res, 200, JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')));
    } catch {
      return send(res, 200, []);
    }
  }
  if (p === '/api/rules' && req.method === 'PUT') {
    const rules = await readBody(req);
    if (!Array.isArray(rules)) return send(res, 400, { error: 'Liste erwartet' });
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Unbekannter Pfad' });
}

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: e.message || 'Interner Fehler' });
    });
  })
  .listen(PORT, () => {
    console.log(`OpenAthlete Masseneditor läuft auf Port ${PORT}, API: ${API}`);
  });
