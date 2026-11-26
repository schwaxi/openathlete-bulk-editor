'use strict';
// Ausrüstung aus dem Garmin-Export übernehmen
//
// Beim Prüfen eines Garmin-Exports legt export-import.js die Ausrüstungsliste samt
// Zuordnungen (welche Aktivität mit welchem Schuh/Rad) in data/garmin-gear.json ab.
// Dieses Modul
//  1. legt die Ausrüstung in OpenAthlete an (dort gibt es nur Schuh und Rad),
//  2. übernimmt Garmins Standard-Ausrüstung pro Sportart,
//  3. setzt die Ausrüstung bei den Aktivitäten (Zuordnung über die Startzeit).
const fs = require('node:fs');
const path = require('node:path');

const MATCH_MS = 120000;
const GAP_MS = Number(process.env.GEAR_PATCH_GAP_MS || 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Garmin-Aktivitätstyp → Sportart in OpenAthlete
const SPORT_OF = {
  running: 'RUNNING', street_running: 'RUNNING', track_running: 'RUNNING', treadmill_running: 'RUNNING',
  indoor_running: 'RUNNING', virtual_run: 'RUNNING', ultra_run: 'RUNNING', obstacle_run: 'RUNNING',
  trail_running: 'TRAIL_RUNNING', hiking: 'HIKING',
  cycling: 'CYCLING', road_biking: 'CYCLING', indoor_cycling: 'CYCLING', recumbent_cycling: 'CYCLING',
  virtual_ride: 'CYCLING', track_cycling: 'CYCLING', cyclocross: 'CYCLING', bmx: 'CYCLING',
  mountain_biking: 'MOUNTAIN_BIKE_RIDE', downhill_biking: 'MOUNTAIN_BIKE_RIDE', gravel_cycling: 'GRAVEL_RIDE',
  e_bike_fitness: 'E_BIKE_RIDE', e_bike_mountain: 'E_MOUNTAIN_BIKE_RIDE', hand_cycling: 'HANDCYCLE',
  lap_swimming: 'SWIMMING', open_water_swimming: 'SWIMMING',
  resort_skiing: 'ALPINE_SKI', resort_skiing_snowboarding_ws: 'ALPINE_SKI',
  backcountry_skiing: 'BACKCOUNTRY_SKI', backcountry_skiing_snowboarding_ws: 'BACKCOUNTRY_SKI',
  cross_country_skiing: 'NORDIC_SKI', cross_country_skiing_ws: 'NORDIC_SKI', skate_skiing_ws: 'NORDIC_SKI',
  indoor_rowing: 'ROWING', rowing: 'ROWING', strength_training: 'STRENGTH',
};
// Diese Garmin-Typen stehen für die ganze Sportart. Unter-Typen wie Laufband oder Liegerad
// würden in OpenAthlete zum Standard für alle Läufe bzw. Fahrten, darum nur vorgeschlagen.
const MAIN_TYPES = new Set(['running', 'trail_running', 'hiking', 'cycling', 'road_biking', 'mountain_biking', 'gravel_cycling', 'e_bike_fitness', 'e_bike_mountain']);
const SHOE_SPORTS = ['RUNNING', 'TRAIL_RUNNING', 'HIKING'];
const BIKE_SPORTS = ['CYCLING', 'MOUNTAIN_BIKE_RIDE', 'GRAVEL_RIDE', 'E_BIKE_RIDE', 'E_MOUNTAIN_BIKE_RIDE', 'HANDCYCLE'];
const fits = (eqType, sport) => (eqType === 'SHOE' ? SHOE_SPORTS : eqType === 'BIKE' ? BIKE_SPORTS : []).includes(sport);
const norm = (s) => String(s || '').toLowerCase().replace(/\(ausgemustert\)/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const nativeType = (g) => (g.type === 'Shoes' ? 'SHOE' : g.type === 'Bike' ? 'BIKE' : null);
const TYPE_DE = { Shoes: 'Schuhe', Bike: 'Rad', Other: 'Sonstiges', Skis: 'Ski' };
const SPORT_DE = {
  RUNNING: 'Laufen', TRAIL_RUNNING: 'Trailrunning', HIKING: 'Wandern', CYCLING: 'Radfahren',
  MOUNTAIN_BIKE_RIDE: 'Mountainbike', GRAVEL_RIDE: 'Gravel', E_BIKE_RIDE: 'E-Bike', E_MOUNTAIN_BIKE_RIDE: 'E-Mountainbike',
  HANDCYCLE: 'Handbike', SWIMMING: 'Schwimmen', ALPINE_SKI: 'Ski alpin', BACKCOUNTRY_SKI: 'Skitour',
  NORDIC_SKI: 'Langlauf', ROWING: 'Rudern', STRENGTH: 'Kraft',
};
const sportDe = (s) => SPORT_DE[s] || s;

function createGearImporter({ dataDir, authed, apiError, logChange }) {
  const gearFile = path.join(dataDir, 'garmin-gear.json');
  let job = null;
  let runner = null;

  const load = () => {
    try { return JSON.parse(fs.readFileSync(gearFile, 'utf8')); } catch { return null; }
  };
  const checkCancel = () => { if (job && job.cancel) throw new Error('__cancel'); };
  const tokensOf = (s) => ({ accessToken: s.accessToken, refreshToken: s.refreshToken });

  async function getList(tokens, urlPath, what) {
    const r = await authed(tokens, 'GET', urlPath);
    if (!r.ok) throw new Error(`${what} nicht abrufbar: ${apiError(r)}`);
    return Array.isArray(r.data) ? r.data : [];
  }

  // Sportarten für ein neues Teil: aus den Aktivitäten, bei denen es in Garmin verwendet wurde
  function sportsFor(type, linkTypes) {
    const set = new Set();
    for (const t of linkTypes) if (SPORT_OF[t]) set.add(SPORT_OF[t]);
    let list = [...set];
    if (type === 'SHOE' || type === 'BIKE') {
      const own = list.filter((s) => fits(type, s));
      if (own.length) list = own; // fremde Sportarten (z. B. Kraft mit Laufschuh) nicht mitnehmen
    }
    if (!list.length) list = type === 'SHOE' ? ['RUNNING'] : ['CYCLING'];
    return list;
  }

  // --- Prüfen ---------------------------------------------------------------
  async function runPreview(tokens) {
    try {
      const data = load();
      if (!data) throw new Error('Keine Ausrüstung gefunden. Bitte zuerst den Garmin-Export „Prüfen“.');
      job.phase = 'Lade Ausrüstung und Aktivitäten aus OpenAthlete …';
      const equipment = await getList(tokens, '/equipment', 'Ausrüstung');
      checkCancel();
      const events = (await getList(tokens, '/event', 'Aktivitäten')).filter((e) => e.type === 'ACTIVITY')
        .map((e) => ({ eventId: e.eventId, start: Date.parse(e.startDate), sport: e.sport, equipmentId: e.equipmentId ?? null, name: e.name }))
        .filter((e) => Number.isFinite(e.start))
        .sort((a, b) => a.start - b.start);
      const nearest = (t) => {
        let lo = 0;
        let hi = events.length - 1;
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (events[mid].start < t) lo = mid + 1; else hi = mid - 1; }
        let best = null;
        for (let i = lo - 3; i <= lo + 3; i++) {
          const e = events[i];
          if (e && Math.abs(e.start - t) <= MATCH_MS && (!best || Math.abs(e.start - t) < Math.abs(best.start - t))) best = e;
        }
        return best;
      };
      // Zuordnungen → OpenAthlete-Aktivität
      const pairs = []; // { gearPk, eventId }
      const perGear = new Map();
      for (const l of data.links) {
        if (/transition/i.test(l.type || '')) continue; // Wechselzonen bekommen keine Ausrüstung
        const st = perGear.get(l.gearPk) || { links: 0, found: 0, types: [] };
        st.links++;
        st.types.push(l.type);
        const e = nearest(l.start);
        if (e) { st.found++; pairs.push({ gearPk: l.gearPk, eventId: e.eventId }); }
        perGear.set(l.gearPk, st);
      }
      const gear = data.gear.map((g) => {
        const st = perGear.get(g.pk) || { links: 0, found: 0, types: [] };
        const retired = g.status === 'retired';
        const oaName = `${g.name.slice(0, retired ? 85 : 100)}${retired ? ' (ausgemustert)' : ''}`;
        const match = equipment.find((q) => norm(q.name) === norm(g.name));
        const type = nativeType(g);
        return {
          pk: g.pk, name: g.name, oaName, garminType: g.type, typeDe: TYPE_DE[g.type] || g.type || '?', retired,
          links: st.links, found: st.found,
          sportsShoe: sportsFor('SHOE', st.types), sportsBike: sportsFor('BIKE', st.types),
          choice: match ? `eq:${match.equipmentId}` : type === 'SHOE' ? 'shoe' : type === 'BIKE' ? 'bike' : 'skip',
          matchName: match ? match.name : null,
        };
      }).sort((a, b) => (a.retired - b.retired) || (b.links - a.links));
      const defaults = data.defaults.map((d, i) => ({
        key: i, activityType: d.activityType, sport: SPORT_OF[d.activityType] || null, gearPk: d.gearPk,
        suggested: MAIN_TYPES.has(d.activityType),
        gearName: (data.gear.find((g) => g.pk === d.gearPk) || {}).name || `#${d.gearPk}`,
      }));
      job.gear = gear;
      job.defaults = defaults;
      job.equipment = equipment.map((q) => ({ equipmentId: q.equipmentId, name: q.name, type: q.type, sports: q.sports || [], isDefault: !!q.isDefault }));
      job.pairs = pairs;
      job.events = new Map(events.map((e) => [e.eventId, e]));
      const evIds = new Set(pairs.map((p) => p.eventId));
      job.stats = {
        gear: gear.length, links: data.links.length, found: pairs.length, events: evIds.size,
        withEquipment: [...evIds].filter((id) => job.events.get(id).equipmentId != null).length,
      };
      job.status = 'ready';
      job.phase = 'Geprüft. Auswahl kontrollieren und „Übernehmen“ klicken.';
    } catch (e) {
      job.status = e.message === '__cancel' ? 'cancelled' : 'failed';
      job.phase = e.message === '__cancel' ? 'Abgebrochen.' : e.message;
    } finally {
      job.cancel = false;
      runner = null;
    }
  }

  // --- Übernehmen -----------------------------------------------------------
  async function runApply(tokens, opts) {
    const res = job.result = { created: [], defaults: [], defaultSkipped: [], assigned: 0, same: 0, kept: 0, failed: [] };
    try {
      const target = new Map(); // gearPk → { equipmentId, type, sports, name }
      // 1. Ausrüstung anlegen bzw. zuordnen
      const toCreate = job.gear.filter((g) => opts.choices[g.pk] === 'shoe' || opts.choices[g.pk] === 'bike');
      let i = 0;
      for (const g of job.gear) {
        checkCancel();
        const c = opts.choices[g.pk] || 'skip';
        if (c.startsWith('eq:')) {
          const q = job.equipment.find((x) => x.equipmentId === Number(c.slice(3)));
          if (q) target.set(g.pk, { equipmentId: q.equipmentId, type: q.type, sports: q.sports, name: q.name });
          continue;
        }
        if (c !== 'shoe' && c !== 'bike') continue;
        const type = c === 'shoe' ? 'SHOE' : 'BIKE';
        const sports = type === 'SHOE' ? g.sportsShoe : g.sportsBike;
        job.phase = `Lege Ausrüstung an … ${++i} von ${toCreate.length}`;
        const r = await authed(tokens, 'POST', '/equipment', { name: g.oaName, type, sports, isDefault: false });
        logChange({ konto: 'Ausrüstung aus Garmin', aktion: 'Ausrüstung angelegt', nachher: { name: g.oaName, type, sports }, ok: r.ok, fehler: r.ok ? undefined : apiError(r) });
        if (!r.ok || !r.data || !r.data.equipmentId) { res.failed.push({ what: `Anlegen „${g.oaName}“`, error: apiError(r) }); continue; }
        target.set(g.pk, { equipmentId: r.data.equipmentId, type, sports, name: g.oaName });
        res.created.push(g.oaName);
      }
      // 2. Standard pro Sportart (in OpenAthlete gilt „Standard“ für alle Sportarten eines Teils)
      if (opts.defaults.size) {
        const cand = job.defaults
          .filter((d) => opts.defaults.has(d.key))
          .map((d) => ({ ...d, t: target.get(d.gearPk) }))
          .filter((d) => {
            if (!d.t) { res.defaultSkipped.push(`${d.gearName}: nicht übernommen`); return false; }
            if (!d.sport || !d.t.sports.includes(d.sport)) { res.defaultSkipped.push(`${d.gearName}: Sportart „${d.activityType}“ passt nicht`); return false; }
            return true;
          })
          .sort((a, b) => (job.gear.find((g) => g.pk === b.gearPk) || {}).links - (job.gear.find((g) => g.pk === a.gearPk) || {}).links);
        const taken = new Set();
        const done = new Set();
        // Standards, die in OpenAthlete schon gesetzt sind, werden nie verdrängt
        const existing = new Map();
        for (const q of job.equipment) if (q.isDefault) for (const s of q.sports) existing.set(s, q);
        for (const d of cand) {
          if (done.has(d.t.equipmentId)) continue;
          const clash = d.t.sports.filter((s) => taken.has(s));
          if (clash.length) { res.defaultSkipped.push(`${d.t.name}: überschneidet sich bei ${clash.map(sportDe).join(', ')} mit einem anderen Standard`); continue; }
          const own = d.t.sports.filter((s) => existing.has(s) && existing.get(s).equipmentId !== d.t.equipmentId);
          if (own.length) {
            res.defaultSkipped.push(`${d.t.name}: in OpenAthlete ist für ${own.map(sportDe).join(', ')} schon „${existing.get(own[0]).name}“ Standard`);
            continue;
          }
          checkCancel();
          const r = await authed(tokens, 'PATCH', `/equipment/${d.t.equipmentId}`, { isDefault: true });
          logChange({ konto: 'Ausrüstung aus Garmin', aktion: 'Standard gesetzt', equipmentId: d.t.equipmentId, nachher: { isDefault: true }, ok: r.ok, fehler: r.ok ? undefined : apiError(r) });
          if (!r.ok) { res.failed.push({ what: `Standard „${d.t.name}“`, error: apiError(r) }); continue; }
          d.t.sports.forEach((s) => taken.add(s));
          done.add(d.t.equipmentId);
          res.defaults.push(`${d.t.name} (${d.t.sports.map(sportDe).join(', ')})`);
        }
      }
      // 3. Aktivitäten
      if (opts.assign) {
        const byEvent = new Map();
        for (const p of job.pairs) {
          const t = target.get(p.gearPk);
          if (!t) continue;
          if (!byEvent.has(p.eventId)) byEvent.set(p.eventId, []);
          byEvent.get(p.eventId).push(t);
        }
        let n = 0;
        for (const [eventId, list] of byEvent) {
          checkCancel();
          n++;
          if (n % 10 === 0) { job.phase = `Setze Ausrüstung bei Aktivitäten … ${n} von ${byEvent.size}`; job.progress = n / byEvent.size; }
          const e = job.events.get(eventId);
          const t = list.find((x) => fits(x.type, e.sport)) || list[0];
          if (e.equipmentId === t.equipmentId) { res.same++; continue; }
          if (e.equipmentId != null && !opts.overwrite) { res.kept++; continue; }
          const r = await authed(tokens, 'PATCH', `/event/${eventId}`, { type: 'ACTIVITY', equipmentId: t.equipmentId });
          logChange({ konto: 'Ausrüstung aus Garmin', eventId, vorher: { equipmentId: e.equipmentId }, nachher: { type: 'ACTIVITY', equipmentId: t.equipmentId }, ok: r.ok, fehler: r.ok ? undefined : apiError(r) });
          if (!r.ok) { res.failed.push({ what: `„${e.name}“ (${new Date(e.start).toISOString().slice(0, 10)})`, error: apiError(r) }); continue; }
          e.equipmentId = t.equipmentId;
          res.assigned++;
          await sleep(GAP_MS);
        }
      }
      job.status = 'done';
      job.progress = 1;
      job.phase = `Fertig: ${res.created.length} Teile angelegt, ${res.defaults.length} Standards gesetzt, ` +
        `${res.assigned} Aktivitäten bekamen ihre Ausrüstung` + (res.failed.length ? `, ${res.failed.length} Fehler` : '') + '.';
    } catch (e) {
      job.status = e.message === '__cancel' ? 'cancelled' : 'failed';
      job.phase = e.message === '__cancel' ? 'Abgebrochen. Bereits angelegte Ausrüstung bleibt.' : e.message;
    } finally {
      job.cancel = false;
      runner = null;
    }
  }

  function publicJob() {
    if (!job) return null;
    return {
      status: job.status, phase: job.phase, progress: job.progress || 0, stats: job.stats || null,
      gear: job.gear || [], defaults: job.defaults || [], equipment: job.equipment || [], result: job.result || null,
    };
  }

  return {
    status() {
      const d = load();
      return { available: d ? { items: d.gear.length, links: d.links.length, createdAt: d.createdAt } : null, job: publicJob() };
    },
    preview(session) {
      if (runner) throw new Error('Es läuft bereits ein Ausrüstungs-Abgleich.');
      job = { status: 'running', phase: 'Starte …', progress: 0, cancel: false };
      runner = runPreview(tokensOf(session));
      return publicJob();
    },
    apply(session, { choices, defaults, assign, overwrite } = {}) {
      if (runner) throw new Error('Es läuft bereits ein Ausrüstungs-Abgleich.');
      if (!job || job.status !== 'ready') throw new Error('Bitte zuerst „Ausrüstung prüfen“.');
      if (!choices || typeof choices !== 'object') throw new Error('Auswahl fehlt');
      const clean = {};
      for (const g of job.gear) {
        const c = String(choices[g.pk] ?? 'skip');
        clean[g.pk] = /^(shoe|bike|skip|eq:\d+)$/.test(c) ? c : 'skip';
      }
      job.status = 'applying';
      job.progress = 0;
      const defKeys = new Set(Array.isArray(defaults) ? defaults.map(Number) : []);
      runner = runApply(tokensOf(session), { choices: clean, defaults: defKeys, assign: assign !== false, overwrite: overwrite === true });
      return publicJob();
    },
    cancel() {
      if (job && runner) job.cancel = true;
      return publicJob();
    },
  };
}

module.exports = { createGearImporter, SPORT_OF };
