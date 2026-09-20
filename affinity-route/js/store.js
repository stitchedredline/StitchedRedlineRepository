/* Affinity Route — local storage, night state, and optional cloud sync.
   Everything works offline first. Sync is a bonus, never a requirement. */
var Store = (function () {
  'use strict';

  var CFG_KEY = 'affinity.cfg.v1';
  var NIGHT_KEY = 'affinity.night.v1';
  var QUEUE_KEY = 'affinity.queue.v1';

  var defaults = {
    propertyId: 'affinity1',
    propertyName: 'Affinity Route',
    apiUrl: '',
    bagCapacity: 12,
    compactorPin: null,
    buildings: [],
    history: {}   // unitId -> { nights, out }
  };

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { return false; }
  }

  /* A shift that runs past midnight is still the same night.
     Anything before 4am counts as the previous day. */
  function nightId(d) {
    d = d || new Date();
    var shifted = new Date(d.getTime() - 4 * 3600 * 1000);
    var m = shifted.getMonth() + 1, day = shifted.getDate();
    return shifted.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  var cfg = Object.assign({}, defaults, read(CFG_KEY, {}));
  var night = read(NIGHT_KEY, null);
  if (!night || night.id !== nightId()) {
    night = { id: nightId(), flags: {}, done: {}, bags: 0, runs: [], startedAt: null, lastPull: 0 };
  }

  function saveCfg() { write(CFG_KEY, cfg); }
  function saveNight() { write(NIGHT_KEY, night); }

  /* ---------- units ---------- */

  function allUnits() {
    var out = [];
    (cfg.buildings || []).forEach(function (b) {
      (b.units || []).forEach(function (u) {
        out.push({ unit: u, building: b });
      });
    });
    return out;
  }

  function findUnit(unitId) {
    var hit = allUnits().filter(function (x) { return x.unit.id === unitId; })[0];
    return hit || null;
  }

  /* "101-108, 110, 201-208" -> ["101",...,"108","110","201",...] */
  function expandUnitList(text) {
    var out = [];
    String(text || '').split(/[,\n]/).forEach(function (chunk) {
      chunk = chunk.trim();
      if (!chunk) return;
      var m = chunk.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        var pad = m[1].length;
        var step = a <= b ? 1 : -1;
        for (var i = a; step > 0 ? i <= b : i >= b; i += step) {
          out.push(String(i).padStart(pad, '0'));
        }
      } else {
        out.push(chunk);
      }
    });
    return out;
  }

  function addBuilding(name) {
    var id = 'B' + (cfg.buildings.length + 1) + '-' + Math.random().toString(36).slice(2, 6);
    cfg.buildings.push({
      id: id,
      name: name || ('Building ' + (cfg.buildings.length + 1)),
      order: cfg.buildings.length + 1,
      pin: null,
      units: []
    });
    saveCfg();
    return id;
  }

  function setUnits(buildingId, labels) {
    var b = cfg.buildings.filter(function (x) { return x.id === buildingId; })[0];
    if (!b) return;
    var existing = {};
    (b.units || []).forEach(function (u) { existing[u.label] = u; });
    b.units = labels.map(function (label, i) {
      var prev = existing[label];
      return {
        id: buildingId + '.' + label,
        label: label,
        order: i + 1,
        note: prev ? prev.note : '',
        skip: prev ? !!prev.skip : false
      };
    });
    saveCfg();
  }

  function reorderBuildings(ids) {
    ids.forEach(function (id, i) {
      var b = cfg.buildings.filter(function (x) { return x.id === id; })[0];
      if (b) b.order = i + 1;
    });
    cfg.buildings.sort(function (a, b) { return a.order - b.order; });
    saveCfg();
  }

  /* ---------- night actions ---------- */

  function flag(unitId, src, at) {
    if (!night.flags[unitId]) {
      night.flags[unitId] = { at: at || Date.now(), src: src || 'manual' };
      saveNight();
      return true;
    }
    return false;
  }

  function markDone(unitId, outcome) {
    night.done[unitId] = { at: Date.now(), outcome: outcome };
    if (outcome === 'picked') night.bags += 1;
    if (!night.startedAt) night.startedAt = Date.now();
    saveNight();
    queue({ type: 'serviced', unit: unitId, outcome: outcome, at: Date.now() });
  }

  function undo(unitId) {
    var d = night.done[unitId];
    if (!d) return;
    if (d.outcome === 'picked') night.bags = Math.max(0, night.bags - 1);
    delete night.done[unitId];
    saveNight();
  }

  function compactorRun() {
    night.runs.push({ at: Date.now(), bags: night.bags });
    night.bags = 0;
    saveNight();
  }

  /* Roll tonight's results into the per-door history that drives prediction. */
  function closeNight() {
    var h = cfg.history || (cfg.history = {});
    allUnits().forEach(function (x) {
      var id = x.unit.id;
      var rec = h[id] || (h[id] = { nights: 0, out: 0 });
      rec.nights += 1;
      var d = night.done[id];
      var hadTrash = !!night.flags[id] || (d && d.outcome === 'picked');
      if (hadTrash) rec.out += 1;
    });
    cfg.lastClosed = night.id;
    saveCfg();
    var summary = {
      id: night.id,
      picked: Object.keys(night.done).filter(function (k) { return night.done[k].outcome === 'picked'; }).length,
      empty: Object.keys(night.done).filter(function (k) { return night.done[k].outcome === 'empty'; }).length,
      runs: night.runs.length,
      minutes: night.startedAt ? Math.round((Date.now() - night.startedAt) / 60000) : 0
    };
    var log = read('affinity.log.v1', []);
    log.unshift(summary);
    write('affinity.log.v1', log.slice(0, 60));
    night = { id: nightId(), flags: {}, done: {}, bags: 0, runs: [], startedAt: null, lastPull: 0 };
    saveNight();
    return summary;
  }

  function resetNight() {
    night = { id: nightId(), flags: {}, done: {}, bags: 0, runs: [], startedAt: null, lastPull: 0 };
    saveNight();
  }

  /* ---------- sync ---------- */

  function queue(evt) {
    var q = read(QUEUE_KEY, []);
    q.push(evt);
    write(QUEUE_KEY, q.slice(-500));
  }

  /* Apps Script blocks a CORS preflight on JSON, so text/plain is used on purpose. */
  function post(body) {
    if (!cfg.apiUrl) return Promise.reject(new Error('no api url'));
    return fetch(cfg.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  /* Some Apps Script deployments still trip CORS on GET, so fall back to JSONP. */
  function jsonp(url) {
    return new Promise(function (resolve, reject) {
      var cb = 'arcb' + Math.random().toString(36).slice(2, 8);
      var s = document.createElement('script');
      var timer = setTimeout(function () { cleanup(); reject(new Error('timeout')); }, 12000);
      function cleanup() { clearTimeout(timer); delete window[cb]; if (s.parentNode) s.parentNode.removeChild(s); }
      window[cb] = function (data) { cleanup(); resolve(data); };
      s.onerror = function () { cleanup(); reject(new Error('jsonp failed')); };
      s.src = url + (url.indexOf('?') < 0 ? '?' : '&') + 'callback=' + cb;
      document.body.appendChild(s);
    });
  }

  function pull() {
    if (!cfg.apiUrl) return Promise.resolve({ skipped: true });
    var url = cfg.apiUrl + '?p=' + encodeURIComponent(cfg.propertyId) +
              '&night=' + encodeURIComponent(night.id) + '&since=' + (night.lastPull || 0);
    return fetch(url).then(function (r) { return r.json(); })
      .catch(function () { return jsonp(url); })
      .then(function (data) {
        var added = 0;
        (data.flags || []).forEach(function (f) {
          if (flag(f.unit, 'qr', f.at)) added++;
        });
        night.lastPull = data.now || Date.now();
        saveNight();
        return { added: added, total: (data.flags || []).length };
      });
  }

  function flushQueue() {
    var q = read(QUEUE_KEY, []);
    if (!q.length || !cfg.apiUrl) return Promise.resolve(0);
    return post({ action: 'events', p: cfg.propertyId, night: night.id, events: q })
      .then(function () { write(QUEUE_KEY, []); return q.length; })
      .catch(function () { return 0; });
  }

  function exportAll() {
    return JSON.stringify({ cfg: cfg, night: night, log: read('affinity.log.v1', []) }, null, 2);
  }

  function importAll(text) {
    var data = JSON.parse(text);
    if (data.cfg) { cfg = Object.assign({}, defaults, data.cfg); saveCfg(); }
    if (data.night && data.night.id === nightId()) { night = data.night; saveNight(); }
    if (data.log) write('affinity.log.v1', data.log);
  }

  return {
    get cfg() { return cfg; },
    get night() { return night; },
    nightId: nightId,
    saveCfg: saveCfg,
    saveNight: saveNight,
    allUnits: allUnits,
    findUnit: findUnit,
    expandUnitList: expandUnitList,
    addBuilding: addBuilding,
    setUnits: setUnits,
    reorderBuildings: reorderBuildings,
    flag: flag,
    markDone: markDone,
    undo: undo,
    compactorRun: compactorRun,
    closeNight: closeNight,
    resetNight: resetNight,
    pull: pull,
    post: post,
    flushQueue: flushQueue,
    log: function () { return read('affinity.log.v1', []); },
    exportAll: exportAll,
    importAll: importAll
  };
})();
