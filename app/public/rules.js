// Regeln nach Kürzel im Namen. Wird im Browser (Vorschau) und im Server
// (automatisches Anwenden nach dem Garmin-Import) gleich verwendet.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OARules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Suchtext → Prüffunktion. Ohne Regex: * = beliebig viele Zeichen,
  // ? = genau ein Zeichen. word = nur als ganzes Wort.
  function makeMatcher(text, word, regex) {
    if (!text) return () => true;
    let re;
    try {
      const src = regex
        ? text
        : text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
      re = word
        ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${src})(?![\\p{L}\\p{N}])`, 'iu')
        : new RegExp(src, 'iu');
    } catch {
      return null; // ungültiger Regex
    }
    return (name) => re.test(name || '');
  }

  // Liefert Map eventId → { sport?, equipmentId? } für alle Aktivitäten,
  // die laut Regeln anders sein sollten. Die erste passende Regel gewinnt.
  function planRules(rules, activities) {
    const plan = new Map();
    const compiled = (Array.isArray(rules) ? rules : [])
      .filter((r) => r && typeof r.keyword === 'string' && r.keyword.trim())
      .map((r) => ({ ...r, match: makeMatcher(r.keyword.trim(), r.word !== false, false) }))
      .filter((r) => r.match);
    for (const a of activities) {
      const ch = {};
      for (const r of compiled) {
        if (!r.match(a.name)) continue;
        if (r.onlySport && r.onlySport !== a.sport) continue;
        if (r.sport && r.sport !== a.sport && ch.sport === undefined) ch.sport = r.sport;
        if (r.equipment && r.equipment !== '') {
          const v = r.equipment === '__none' ? null : Number(r.equipment);
          if ((v ?? null) !== (a.equipmentId ?? null) && ch.equipmentId === undefined) ch.equipmentId = v;
        }
      }
      if (Object.keys(ch).length) plan.set(a.eventId, ch);
    }
    return plan;
  }

  return { makeMatcher, planRules };
});
