/* Affinity Route — routing + prediction logic. Pure functions, no DOM.
   Works in the browser and in node (for tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Route = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- geo ---------- */

  function haversine(a, b) {
    if (!a || !b) return null;
    var R = 20902231; // ft
    var toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad;
    var dLng = (b.lng - a.lng) * toRad;
    var la1 = a.lat * toRad, la2 = b.lat * toRad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
  }

  /* Total walking distance of an ordered list of pinned points,
     starting and ending at `home` (the compactor). */
  function tourLength(points, home) {
    if (!points.length) return 0;
    var total = 0, prev = home || points[0];
    for (var i = 0; i < points.length; i++) {
      total += haversine(prev, points[i]) || 0;
      prev = points[i];
    }
    if (home) total += haversine(prev, home) || 0;
    return total;
  }

  /* Nearest-neighbour seed, then 2-opt until no improvement.
     19 buildings is tiny, so this is exact enough and runs instantly. */
  function optimizeOrder(items, home) {
    var pinned = items.filter(function (it) { return it.pin && isFinite(it.pin.lat); });
    var unpinned = items.filter(function (it) { return !(it.pin && isFinite(it.pin.lat)); });
    if (pinned.length < 3) return items.slice();

    var remaining = pinned.slice();
    var order = [];
    var cur = home || remaining[0].pin;
    while (remaining.length) {
      var bestI = 0, bestD = Infinity;
      for (var i = 0; i < remaining.length; i++) {
        var d = haversine(cur, remaining[i].pin);
        if (d !== null && d < bestD) { bestD = d; bestI = i; }
      }
      cur = remaining[bestI].pin;
      order.push(remaining.splice(bestI, 1)[0]);
    }

    var improved = true, guard = 0;
    while (improved && guard++ < 200) {
      improved = false;
      for (var a = 0; a < order.length - 1; a++) {
        for (var b = a + 1; b < order.length; b++) {
          var candidate = order.slice(0, a)
            .concat(order.slice(a, b + 1).reverse())
            .concat(order.slice(b + 1));
          if (tourLength(candidate.map(p), home) + 1 < tourLength(order.map(p), home)) {
            order = candidate; improved = true;
          }
        }
      }
    }
    function p(it) { return it.pin; }
    return order.concat(unpinned);
  }

  /* ---------- prediction ---------- */

  /* Hit rate = how often this door actually puts trash out.
     Unknown doors sit at 0.5 so they are neither trusted nor written off. */
  function hitRate(hist) {
    if (!hist || !hist.nights) return 0.5;
    return hist.out / hist.nights;
  }

  function confidence(hist) {
    if (!hist || hist.nights < 3) return 'new';
    var r = hitRate(hist);
    if (r >= 0.75) return 'likely';
    if (r <= 0.15) return 'rare';
    return 'mixed';
  }

  /* ---------- plan ---------- */

  /* Build tonight's walking plan.
     mode:
       'confirmed' — only doors that scanned the QR (+ manual adds). Fastest.
       'smart'     — confirmed doors plus doors that historically put trash out.
       'sweep'     — every door. Falls back to this when there is no data yet. */
  function buildPlan(cfg, night, mode) {
    mode = mode || 'smart';
    var flags = night.flags || {};
    var done = night.done || {};
    var hist = cfg.history || {};

    var buildings = (cfg.buildings || []).slice().sort(function (x, y) {
      return (x.order || 0) - (y.order || 0);
    });

    var plan = buildings.map(function (b) {
      var units = (b.units || []).slice().sort(function (x, y) {
        return (x.order || 0) - (y.order || 0);
      });
      var stops = [];
      var skipped = 0;

      units.forEach(function (u) {
        var flag = flags[u.id];
        var h = hist[u.id];
        var conf = confidence(h);
        var include =
          mode === 'sweep' ? true :
          mode === 'confirmed' ? !!flag :
          (!!flag || conf === 'likely' || conf === 'new');

        if (u.skip) include = false;
        if (!include) { skipped++; return; }

        stops.push({
          unitId: u.id,
          label: u.label,
          buildingId: b.id,
          buildingName: b.name,
          note: u.note || '',
          confirmed: !!flag,
          flaggedAt: flag ? flag.at : null,
          confidence: conf,
          rate: hitRate(h),
          done: !!done[u.id],
          outcome: done[u.id] ? done[u.id].outcome : null
        });
      });

      var open = stops.filter(function (s) { return !s.done; });
      return {
        id: b.id,
        name: b.name,
        pin: b.pin || null,
        stops: stops,
        openCount: open.length,
        confirmedCount: stops.filter(function (s) { return s.confirmed && !s.done; }).length,
        skippedDoors: skipped,
        totalDoors: units.length,
        skipBuilding: open.length === 0
      };
    });

    var allStops = [];
    plan.forEach(function (b) {
      b.stops.forEach(function (s) { if (!s.done) allStops.push(s); });
    });

    return {
      mode: mode,
      buildings: plan,
      stops: allStops,
      doorsTotal: plan.reduce(function (n, b) { return n + b.totalDoors; }, 0),
      doorsSaved: plan.reduce(function (n, b) { return n + b.skippedDoors; }, 0),
      buildingsSkipped: plan.filter(function (b) { return b.skipBuilding; }).length
    };
  }

  /* Where to break for a compactor run: finish the building you are in if you can
     carry the rest of it, otherwise dump now. */
  function compactorAdvice(plan, bagsCarried, capacity, currentBuildingId) {
    var room = capacity - bagsCarried;
    if (room > 2) return { dump: false, reason: 'room for ' + room + ' more' };
    var b = plan.buildings.filter(function (x) { return x.id === currentBuildingId; })[0];
    var leftHere = b ? b.openCount : 0;
    if (room <= 0) return { dump: true, reason: 'hands full — dump now' };
    if (leftHere <= room) return { dump: false, reason: 'finish this building first (' + leftHere + ' left)' };
    return { dump: true, reason: 'dump now, ' + leftHere + ' doors left here' };
  }

  return {
    haversine: haversine,
    tourLength: tourLength,
    optimizeOrder: optimizeOrder,
    hitRate: hitRate,
    confidence: confidence,
    buildPlan: buildPlan,
    compactorAdvice: compactorAdvice
  };
}));
