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

  /* ---------- spoken numbers ---------- */

  var WORDS = {
    zero:0, oh:0, o:0, nought:0,
    one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
    ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15,
    sixteen:16, seventeen:17, eighteen:18, nineteen:19,
    twenty:20, thirty:30, forty:40, fourty:40, fifty:50,
    sixty:60, seventy:70, eighty:80, ninety:90,
    /* things dictation hears instead of digits when you are outside at night */
    to:2, too:2, for:4, fore:4, ate:8, won:1, free:3, tree:3, nine_:9
  };

  var COMMANDS = {
    'next building': 'next', 'next': 'next', 'next bldg': 'next',
    'undo': 'undo', 'scratch that': 'undo', 'back': 'undo', 'no wait': 'undo',
    'done': 'done', 'finished': 'done', 'clear': 'clear'
  };

  function spokenCommand(text) {
    var t = String(text || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (COMMANDS[t]) return COMMANDS[t];
    if (/\bnext building\b/.test(t)) return 'next';
    if (/\bundo\b|\bscratch that\b/.test(t)) return 'undo';
    return null;
  }

  /* "two oh four" -> ["204"].  "204 211 and 306" -> ["204","211","306"].
     Returns every apartment number it can find in one utterance, so you can
     rattle off a whole hallway in one breath. */
  function parseSpokenUnits(text) {
    var tokens = String(text || '').toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

    var out = [];
    var run = [];        // numeric pieces of the number being built
    var pendingHundred = false;

    function flush() {
      if (!run.length) { pendingHundred = false; return; }
      var parts = run.slice();
      /* "twenty three" is 23, not 203 */
      for (var i = 0; i < parts.length - 1; i++) {
        if (parts[i] >= 20 && parts[i] <= 90 && parts[i] % 10 === 0 &&
            parts[i + 1] >= 1 && parts[i + 1] <= 9) {
          parts.splice(i, 2, parts[i] + parts[i + 1]);
        }
      }
      var s = parts.map(String).join('');
      if (s.length) out.push(s);
      run = [];
      pendingHundred = false;
    }

    tokens.forEach(function (tok) {
      if (/^\d+$/.test(tok)) {
        /* "204 211" is two doors, not one 6-digit number */
        if (tok.length >= 2 && run.length) flush();
        run.push(parseInt(tok, 10));
        return;
      }
      if (tok === 'hundred') {
        /* "one hundred four" -> 1*100 + 4 */
        if (run.length) {
          var base = run.pop() * 100;
          run.push(base);
          pendingHundred = true;
        }
        return;
      }
      if (WORDS.hasOwnProperty(tok)) {
        var v = WORDS[tok];
        if (pendingHundred && run.length) {
          run[run.length - 1] += v;
          pendingHundred = false;
        } else {
          run.push(v);
        }
        return;
      }
      /* any other word ends the current number */
      flush();
    });
    flush();
    return out;
  }

  /* "building twenty two oh six" / "building 2206" -> "2206" */
  function spokenBuilding(text) {
    var t = String(text || '').toLowerCase();
    var m = t.match(/\b(?:building|bldg|address)\b(.*)$/);
    if (!m) return null;
    var nums = parseSpokenUnits(m[1]);
    return nums.length ? nums[0] : null;
  }

  function matchBuilding(cfg, spoken) {
    var want = String(spoken).toLowerCase();
    var hits = (cfg.buildings || []).filter(function (b) {
      return String(b.name).toLowerCase() === want;
    });
    return hits.length === 1 ? hits[0] : null;
  }

  /* Match what you said against real doors. The building you are standing in
     wins, because 101 exists in every building on the property. */
  function matchUnits(cfg, spoken, currentBuildingId) {
    var hits = [];
    (cfg.buildings || []).forEach(function (b) {
      (b.units || []).forEach(function (u) {
        if (String(u.label) === String(spoken)) {
          hits.push({ unitId: u.id, label: u.label, buildingId: b.id, buildingName: b.name });
        }
      });
    });
    var here = hits.filter(function (h) { return h.buildingId === currentBuildingId; });
    return { exact: here.length === 1 ? here[0] : null, all: hits, here: here };
  }

  /* ---------- spoken floors and bag counts ---------- */

  var ORDINALS = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
    seventh: 7, eighth: 8, ninth: 9, tenth: 10,
    '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5, '6th': 6,
    '7th': 7, '8th': 8, '9th': 9, '10th': 10
  };
  var FLOOR_WORD = { floor: 1, floors: 1, flr: 1, level: 1, story: 1, storey: 1 };
  var ZERO_WORD = { none: 1, nothing: 1, empty: 1, nada: 1, clear: 1, zip: 1 };
  var BAG_WORD = { bag: 1, bags: 1, bagged: 1 };

  /* "Top floor, left side, third floor zero bags, second floor two bags,
      bottom floor three bags" -> an ordered list of what you just said.
     Emits side/floor/bags events in the order spoken; the caller tracks which
     floor and side are current, exactly the way you walk it. */
  function parseFloorCall(text, topFloor) {
    var tokens = String(text || '').toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

    var events = [];
    var held = null;            // a number/top/bottom waiting for "floor" or "bags"
    var expectFloorNumber = false;
    var sawFloor = false;

    function resolve(h) {
      if (!h) return null;
      if (h.kind === 'top') return topFloor || null;
      if (h.kind === 'bottom') return 1;
      return h.v;
    }

    tokens.forEach(function (tok) {
      if (tok === 'left' || tok === 'right') {
        events.push({ type: 'side', value: tok });
        return;
      }
      if (tok === 'side' || tok === 'stairwell' || tok === 'wing') return;

      if (tok === 'top' || tok === 'upper') { held = { kind: 'top' }; return; }
      if (tok === 'bottom' || tok === 'ground' || tok === 'lower' || tok === 'lobby') {
        held = { kind: 'bottom' }; return;
      }

      if (ORDINALS.hasOwnProperty(tok)) { held = { kind: 'num', v: ORDINALS[tok] }; return; }

      if (FLOOR_WORD.hasOwnProperty(tok)) {
        if (held) {
          var f = resolve(held);
          if (f !== null) { events.push({ type: 'floor', value: f }); sawFloor = true; }
          held = null;
        } else {
          expectFloorNumber = true;   // "floor three"
        }
        return;
      }

      if (BAG_WORD.hasOwnProperty(tok)) {
        if (held && held.kind === 'num') {
          events.push({ type: 'bags', value: held.v });
          held = null;
        }
        return;
      }

      if (ZERO_WORD.hasOwnProperty(tok)) {
        events.push({ type: 'bags', value: 0 });
        held = null;
        return;
      }

      var n = null;
      if (/^\d+$/.test(tok)) n = parseInt(tok, 10);
      else if (WORDS.hasOwnProperty(tok)) n = WORDS[tok];

      if (n !== null) {
        if (expectFloorNumber) {
          events.push({ type: 'floor', value: n });
          sawFloor = true;
          expectFloorNumber = false;
        } else {
          held = { kind: 'num', v: n };
        }
        return;
      }

      /* an unrelated word breaks the phrase */
      held = null;
      expectFloorNumber = false;
    });

    /* "third floor zero" — a trailing bare number is the bag count. */
    if (held && held.kind === 'num' && sawFloor) {
      events.push({ type: 'bags', value: held.v });
    }
    return events;
  }

  /* Fold the spoken events into concrete {side, floor, bags} entries. */
  function applyFloorCall(events, state) {
    var side = state && state.side || null;
    var floor = state && state.floor || null;
    var out = [];
    events.forEach(function (ev) {
      if (ev.type === 'side') { side = ev.value; return; }
      if (ev.type === 'floor') { floor = ev.value; return; }
      if (ev.type === 'bags' && floor !== null) {
        out.push({ side: side, floor: floor, bags: ev.value });
      }
    });
    return { entries: out, side: side, floor: floor };
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
        /* Smart mode only drops a door that has proven itself reliably empty.
           A door that is hit-or-miss still gets checked — missing real trash
           costs a complaint, checking one extra door costs three seconds. */
        var include =
          mode === 'sweep' ? true :
          mode === 'confirmed' ? !!flag :
          (!!flag || conf !== 'rare');

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
    parseSpokenUnits: parseSpokenUnits,
    parseFloorCall: parseFloorCall,
    applyFloorCall: applyFloorCall,
    spokenCommand: spokenCommand,
    matchUnits: matchUnits,
    matchBuilding: matchBuilding,
    spokenBuilding: spokenBuilding,
    haversine: haversine,
    tourLength: tourLength,
    optimizeOrder: optimizeOrder,
    hitRate: hitRate,
    confidence: confidence,
    buildPlan: buildPlan,
    compactorAdvice: compactorAdvice
  };
}));
