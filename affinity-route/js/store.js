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
    bagLimitPerUnit: 3,
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

  function freshNight() {
    return { id: nightId(), flags: {}, done: {}, bags: 0, runs: [], overLimit: [],
             startedAt: null, lastPull: 0, assumeOut: false, visited: {},
             atBuilding: null, floorBags: {}, atSide: 'left', atFloor: null };
  }

  var cfg = Object.assign({}, defaults, read(CFG_KEY, {}));
  var night = read(NIGHT_KEY, null);
  if (!night || night.id !== nightId()) {
    night = freshNight();
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

  /* Deterministic id from the building's number, so a route that gets reloaded
     from route.json keeps every door's history instead of orphaning it. */
  function buildingIdFor(name) {
    return 'b-' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  /* "2202: 101-108, 201-208" per line — paste the whole property at once. */
  function parseRouteText(text) {
    var out = [];
    String(text || '').split(/\n/).forEach(function (line) {
      line = line.replace(/^\s*[#\/].*$/, '').trim();
      if (!line) return;
      var m = line.match(/^([^:]+?)\s*[:\t]\s*(.+)$/) || line.match(/^(\S+)\s+(.+)$/);
      if (!m) return;
      var units = expandUnitList(m[2]);
      if (!units.length) return;
      out.push({ name: m[1].trim(), units: units });
    });
    return out;
  }

  /* Replace the route wholesale. History is keyed by unit id, and ids are
     derived from the building number, so it survives this. */
  function importRoute(list) {
    cfg.buildings = list.map(function (b, i) {
      var id = buildingIdFor(b.name);
      return {
        id: id,
        name: String(b.name),
        order: i + 1,
        floors: b.floors || null,
        sides: (b.sides && b.sides.length) ? b.sides.slice() : null,
        section: b.section || null,
        note: b.note || '',
        floorNotes: Object.assign({}, b.floorNotes || {}),
        pin: (cfg.buildings.filter(function (old) { return old.id === id; })[0] || {}).pin || null,
        units: (b.units || []).map(function (label, j) {
          return { id: id + '.' + label, label: String(label), order: j + 1, note: '', skip: false };
        })
      };
    });
    saveCfg();
    return cfg.buildings.length;
  }

  /* Pull the shared route.json that ships with the repo. Lets the route be
     edited on a laptop and picked up by the phone. */
  function loadSeed(url) {
    return fetch((url || 'route.json') + '?t=' + Date.now())
      .then(function (r) {
        if (!r.ok) throw new Error('route.json not found');
        return r.json();
      })
      .then(function (data) {
        if (data.propertyName) cfg.propertyName = data.propertyName;
        if (data.propertyId) cfg.propertyId = data.propertyId;
        if (data.bagCapacity) cfg.bagCapacity = data.bagCapacity;
        if (data.bagLimitPerUnit) cfg.bagLimitPerUnit = data.bagLimitPerUnit;
        if (!data.buildings || !data.buildings.length) throw new Error('route.json has no buildings');
        var n = importRoute(data.buildings);
        return { buildings: n, doors: allUnits().length };
      });
  }

  function addBuilding(name) {
    var base = name || ('Building ' + (cfg.buildings.length + 1));
    var id = buildingIdFor(base);
    while (cfg.buildings.some(function (b) { return b.id === id; })) id += '-x';
    cfg.buildings.push({
      id: id,
      name: base,
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

  /* ---------- floors ---------- */

  /* Most buildings here are walked as floor + side, not as a list of doors.
     A door number carries its floor in the first digit (204 -> floor 2), so
     the two models line up when door numbers exist. */
  function floorsOf(b) {
    if (!b) return [];
    if (b.units && b.units.length) {
      var seen = {};
      b.units.forEach(function (u) {
        var f = parseInt(String(u.label).charAt(0), 10);
        if (f > 0) seen[f] = true;
      });
      var list = Object.keys(seen).map(Number).sort(function (x, y) { return y - x; });
      if (list.length) return list;
    }
    var n = b.floors || 3;
    var out = [];
    for (var i = n; i >= 1; i--) out.push(i);
    return out;   // top floor first — that is the way it gets walked
  }

  function sidesOf(b) {
    if (!b) return [];
    return (b.sides && b.sides.length) ? b.sides : ['left', 'right'];
  }

  function floorKey(buildingId, side, floor) {
    return buildingId + '|' + (side || '-') + '|' + floor;
  }

  /* A standing fact about one floor of one stairwell — "top floor is the cat
     lady", so the heavy litter bags are no surprise next week. */
  function floorNote(building, side, floor) {
    if (!building) return '';
    return (building.floorNotes || {})[(side || '-') + '|' + floor] || '';
  }

  function setFloorNote(buildingId, side, floor, text) {
    var b = (cfg.buildings || []).filter(function (x) { return x.id === buildingId; })[0];
    if (!b) return false;
    b.floorNotes = b.floorNotes || {};
    var k = (side || '-') + '|' + floor;
    if (text) b.floorNotes[k] = String(text);
    else delete b.floorNotes[k];
    saveCfg();
    return true;
  }

  /* A door that put out more than the posted limit. This is the record a
     notice to the resident gets written from, so it keeps the unit, where it
     was, and what the limit was on the night. */
  function logOverLimit(buildingId, side, floor, unit, bags) {
    night.overLimit = night.overLimit || [];
    var rec = { building: buildingId, side: side || null, floor: floor || null,
                unit: String(unit), bags: bags | 0,
                limit: cfg.bagLimitPerUnit || null, at: Date.now() };
    night.overLimit.push(rec);
    saveNight();
    queue({ type: 'overlimit', building: buildingId, unit: rec.unit,
            bags: rec.bags, limit: rec.limit, at: rec.at });
    return rec;
  }

  function overLimitList() { return (night.overLimit || []).slice(); }

  function setFloorBags(buildingId, side, floor, bags) {
    var k = floorKey(buildingId, side, floor);
    if (bags === null || bags === undefined) delete night.floorBags[k];
    else night.floorBags[k] = { bags: Math.max(0, bags | 0), at: Date.now() };
    if (!night.startedAt) night.startedAt = Date.now();
    night.atSide = side;
    night.atFloor = floor;
    saveNight();
    queue({ type: 'floor', building: buildingId, side: side, floor: floor, bags: bags, at: Date.now() });
  }

  function getFloorBags(buildingId, side, floor) {
    var rec = night.floorBags[floorKey(buildingId, side, floor)];
    return rec ? rec.bags : null;
  }

  function buildingBags(buildingId) {
    var total = 0, logged = 0;
    Object.keys(night.floorBags).forEach(function (k) {
      if (k.split('|')[0] !== buildingId) return;
      total += night.floorBags[k].bags;
      logged++;
    });
    return { bags: total, floorsLogged: logged };
  }

  function totalFloorBags() {
    return Object.keys(night.floorBags).reduce(function (n, k) {
      return n + night.floorBags[k].bags;
    }, 0);
  }

  /* Sunday mode: assume every door has trash and only log the exceptions.
     Far fewer taps on a busy night, and it fills in history much faster. */
  function setAssumeOut(on) {
    night.assumeOut = !!on;
    if (!night.startedAt) night.startedAt = Date.now();
    saveNight();
  }

  function setBuilding(buildingId) {
    night.atBuilding = buildingId;
    saveNight();
  }

  /* Mark a building walked, so doors you never reached are not scored as
     "had trash" when the night is closed out. */
  function markBuildingWalked(buildingId) {
    night.visited[buildingId] = Date.now();
    saveNight();
  }

  function isEmpty(unitId) {
    var d = night.done[unitId];
    return !!(d && d.outcome === 'empty');
  }

  function toggleEmpty(unitId) {
    if (isEmpty(unitId)) { undo(unitId); return false; }
    night.done[unitId] = { at: Date.now(), outcome: 'empty' };
    if (!night.startedAt) night.startedAt = Date.now();
    saveNight();
    queue({ type: 'serviced', unit: unitId, outcome: 'empty', at: Date.now() });
    return true;
  }

  function emptyCount(buildingId) {
    return Object.keys(night.done).filter(function (k) {
      if (night.done[k].outcome !== 'empty') return false;
      if (!buildingId) return true;
      var hit = findUnit(k);
      return hit && hit.building.id === buildingId;
    }).length;
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
      var d = night.done[id];
      var walked = !!night.visited[x.building.id];

      /* In empty-log mode an untouched door in a building you walked means
         "had trash". A door in a building you never reached tells us nothing,
         so it is left out of the average entirely. */
      var hadTrash, counts;
      if (night.assumeOut) {
        counts = walked || !!d;
        hadTrash = counts && !(d && d.outcome === 'empty');
      } else {
        counts = !!d || !!night.flags[id];
        hadTrash = !!night.flags[id] || (d && d.outcome === 'picked');
      }
      if (!counts) return;

      var rec = h[id] || (h[id] = { nights: 0, out: 0 });
      rec.nights += 1;
      if (hadTrash) rec.out += 1;
    });
    /* Floor-level history: average bags and how often a floor-side is dead.
       This is what lets the app eventually say "skip the top floor of 2202". */
    var fh = cfg.floorHistory || (cfg.floorHistory = {});
    Object.keys(night.floorBags).forEach(function (k) {
      var rec = fh[k] || (fh[k] = { nights: 0, bags: 0, empties: 0 });
      var bags = night.floorBags[k].bags;
      rec.nights += 1;
      rec.bags += bags;
      if (bags === 0) rec.empties += 1;
    });

    cfg.lastClosed = night.id;
    saveCfg();
    var summary = {
      id: night.id,
      floorBags: totalFloorBags(),
      buildingsWalked: Object.keys(night.visited).length,
      picked: Object.keys(night.done).filter(function (k) { return night.done[k].outcome === 'picked'; }).length,
      empty: Object.keys(night.done).filter(function (k) { return night.done[k].outcome === 'empty'; }).length,
      runs: night.runs.length,
      overLimit: (night.overLimit || []).slice(),
      minutes: night.startedAt ? Math.round((Date.now() - night.startedAt) / 60000) : 0
    };
    var log = read('affinity.log.v1', []);
    log.unshift(summary);
    write('affinity.log.v1', log.slice(0, 60));
    night = freshNight();
    saveNight();
    return summary;
  }

  function resetNight() {
    night = freshNight();
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
    parseRouteText: parseRouteText,
    importRoute: importRoute,
    loadSeed: loadSeed,
    buildingIdFor: buildingIdFor,
    setUnits: setUnits,
    reorderBuildings: reorderBuildings,
    flag: flag,
    markDone: markDone,
    setAssumeOut: setAssumeOut,
    floorsOf: floorsOf,
    floorNote: floorNote,
    setFloorNote: setFloorNote,
    logOverLimit: logOverLimit,
    overLimitList: overLimitList,
    sidesOf: sidesOf,
    floorKey: floorKey,
    setFloorBags: setFloorBags,
    getFloorBags: getFloorBags,
    buildingBags: buildingBags,
    totalFloorBags: totalFloorBags,
    setBuilding: setBuilding,
    markBuildingWalked: markBuildingWalked,
    isEmpty: isEmpty,
    toggleEmpty: toggleEmpty,
    emptyCount: emptyCount,
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
