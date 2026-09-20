/* Affinity Route — count bags by floor.
   The way the route actually gets walked: pick a side, start at the top,
   call out what each floor gave you. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var cfg = Store.cfg;

  var buildings = cfg.buildings.slice().sort(function (a, b) { return a.order - b.order; });
  if (!buildings.length) {
    document.querySelector('.wrap').innerHTML =
      '<h1>No route yet</h1><p class="muted">Add your buildings first.</p>' +
      '<a class="btn" href="setup.html">Route setup</a>';
    return;
  }

  var idx = Math.max(0, buildings.findIndex(function (b) { return b.id === Store.night.atBuilding; }));
  var side = Store.night.atSide || 'left';
  var listening = false, speakBack = localStorage.getItem('affinity.speak') !== 'off';
  var rec = null, wakeLock = null, lastActed = [];

  function building() { return buildings[idx]; }
  function setSide(s) {
    side = s;
    Store.night.atSide = s;
    Store.saveNight();
  }
  function floors() { return Store.floorsOf(building()); }
  function topFloor() { return floors()[0]; }
  function sides() { return Store.sidesOf(building()); }

  /* ---------- feedback ---------- */

  var actx = null;
  function beep(hz, ms) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      var o = actx.createOscillator(), g = actx.createGain();
      o.connect(g); g.connect(actx.destination);
      o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.25, actx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + ms / 1000);
      o.start(); o.stop(actx.currentTime + ms / 1000 + 0.02);
    } catch (e) {}
  }
  function say(t) {
    if (!speakBack || !window.speechSynthesis) return;
    try {
      var u = new SpeechSynthesisUtterance(t);
      u.rate = 1.3;
      speechSynthesis.speak(u);
    } catch (e) {}
  }
  function feedback(ok, big, sub) {
    var el = $('heardBig');
    el.textContent = big;
    el.className = 'heardbig ' + (ok ? 'good' : 'bad');
    $('heardSub').textContent = sub || '';
    beep(ok ? 880 : 240, ok ? 90 : 220);
  }

  function esc(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function floorName(f) {
    if (f === topFloor() && f !== 1) return 'Top floor';
    if (f === 1) return 'Bottom floor';
    return ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'][f] + ' floor';
  }

  /* ---------- logging ---------- */

  function log(f, bags, viaVoice) {
    if (floors().indexOf(f) < 0) {
      feedback(false, 'Floor ' + f, building().name + ' does not have a floor ' + f);
      if (viaVoice) say('no floor ' + f);
      return false;
    }
    Store.setFloorBags(building().id, side, f, bags);
    lastActed.push({ b: building().id, s: side, f: f });
    feedback(true, bags + (bags === 1 ? ' bag' : ' bags'), floorName(f) + ', ' + side + ' side');
    if (viaVoice) say(bags === 0 ? floorName(f) + ' clear' : bags + ' on ' + floorName(f));
    render();
    return true;
  }

  /* A door over the posted limit. Written down where it happened, because the
     property needs the unit number and the count, not a memory of it. */
  function logOver(hit) {
    var rec = Store.logOverLimit(building().id, side, Store.night.atFloor, hit.unit, hit.bags);
    var n = Store.overLimitList().length;
    feedback(true, 'Unit ' + hit.unit + ' · ' + hit.bags + ' bags',
      (rec.limit ? 'over the ' + rec.limit + '-bag limit' : 'logged') +
      ' · ' + n + ' flagged tonight');
    say('unit ' + String(hit.unit).split('').join(' ') + ' over limit');
    render();
  }

  function undoLast() {
    var last = lastActed.pop();
    if (!last) return feedback(false, '—', 'nothing to undo');
    Store.setFloorBags(last.b, last.s, last.f, null);
    feedback(true, '—', 'undid ' + floorName(last.f));
    say('undone');
    render();
  }

  /* ---------- voice ---------- */

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function handleUtterance(result) {
    var texts = [];
    for (var i = 0; i < result.length; i++) texts.push(result[i].transcript);

    for (var t = 0; t < texts.length; t++) {
      var cmd = Route.spokenCommand(texts[t]);
      if (cmd === 'next') { nextBuilding(); return; }
      if (cmd === 'undo') { undoLast(); return; }

      var wantBldg = Route.spokenBuilding(texts[t]);
      if (wantBldg) {
        var b = Route.matchBuilding(cfg, wantBldg);
        if (b) { idx = buildings.findIndex(function (x) { return x.id === b.id; });
                 Store.setBuilding(b.id); render();
                 feedback(true, b.name, 'now walking ' + b.name);
                 say('building ' + String(b.name).split('').join(' ')); return; }
        feedback(false, wantBldg, 'no building ' + wantBldg + ' on your route');
        return;
      }
    }

    /* An aside about one door rides along in the same breath as the counts:
       "...six on the bottom floor, unit 1318 has six bags, too many."
       Pull it out first so the floor parser never sees it, and log it after the
       floors, when the current floor is the one that door is on. */
    var over = null;
    for (var o = 0; o < texts.length; o++) {
      over = Route.parseOverLimit(texts[o]);
      if (over) break;
    }

    /* Try each alternative; take the first that yields a real floor+count. */
    var handled = false;
    for (var a = 0; a < texts.length && !handled; a++) {
      var events = Route.parseFloorCall(Route.stripUnitAside(texts[a]), topFloor());
      var applied = Route.applyFloorCall(events, { side: side, floor: Store.night.atFloor });
      if (applied.side && applied.side !== side && sides().indexOf(applied.side) > -1) {
        setSide(applied.side);
      }
      if (applied.entries.length) {
        applied.entries.forEach(function (e) {
          if (e.side && sides().indexOf(e.side) > -1) side = e.side;
          log(e.floor, e.bags, true);
        });
        handled = true;
        break;
      }
      /* Side-only call: "switch to the right side" */
      if (applied.side && applied.side !== Store.night.atSide) {
        setSide(applied.side);
        feedback(true, side + ' side', 'switched sides');
        say(side + ' side');
        render();
        handled = true;
      }
    }

    if (over) { logOver(over); handled = true; }
    if (!handled) feedback(false, '?', 'heard "' + texts[0] + '"');
  }

  function startListening() {
    if (!SR) return feedback(false, 'No mic',
      'This browser will not do voice. Use the +/- buttons.');
    rec = new SR();
    rec.continuous = true; rec.interimResults = false;
    rec.lang = 'en-US'; rec.maxAlternatives = 3;
    rec.onresult = function (e) {
      for (var i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) handleUtterance(e.results[i]);
      }
    };
    rec.onerror = function (e) {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        listening = false; paint();
        feedback(false, 'Mic blocked', 'Allow the microphone, or use the buttons.');
      }
    };
    rec.onend = function () { if (listening) { try { rec.start(); } catch (e) {} } };
    try { rec.start(); listening = true; } catch (e) { listening = false; }
    paint();
    if (navigator.wakeLock) {
      navigator.wakeLock.request('screen').then(function (w) { wakeLock = w; }).catch(function () {});
    }
  }

  function stopListening() {
    listening = false;
    if (rec) { try { rec.stop(); } catch (e) {} }
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
    paint();
  }

  /* ---------- buildings / sides ---------- */

  /* Speak a building's standing note when you walk up to it — hands are full
     and the screen is in a pocket. Once per arrival, not once per render. */
  var noteSaid = null;
  function announceNote() {
    var b = building();
    if (!b.note || noteSaid === b.id) return;
    noteSaid = b.id;
    beep(660, 140);
    say(b.note);
  }

  function goto(i) {
    idx = Math.max(0, Math.min(buildings.length - 1, i));
    if (buildings[idx].id !== (noteSaid || '')) noteSaid = null;
    Store.setBuilding(building().id);
    if (sides().indexOf(side) < 0) side = sides()[0];
    render();
    announceNote();
  }

  function nextBuilding() {
    var remaining = sides().filter(function (s) {
      return floors().some(function (f) { return Store.getFloorBags(building().id, s, f) === null; });
    });
    if (remaining.length && remaining.indexOf(side) < 0) {
      side = remaining[0];
      feedback(true, side + ' side', 'other side of ' + building().name + ' still open');
      say(side + ' side');
      render();
      return;
    }
    Store.markBuildingWalked(building().id);
    if (idx >= buildings.length - 1) {
      feedback(true, 'Done', 'That was the last building.');
      say('route complete');
      render();
      return;
    }
    goto(idx + 1);
    feedback(true, building().name, 'now walking ' + building().name);
    say('building ' + String(building().name).split('').join(' '));
  }

  /* ---------- render ---------- */

  function render() {
    var b = building();
    $('bName').textContent = b.name;
    var bb = Store.buildingBags(b.id);
    $('bMeta').textContent = floors().length + ' floors · ' + bb.bags + ' bags · building ' +
      (idx + 1) + ' of ' + buildings.length + (Store.night.visited[b.id] ? ' · walked' : '');

    var note = $('bNote');
    note.textContent = b.note ? '\u26a0 ' + b.note : '';
    note.hidden = !b.note;

    var tabs = $('sideTabs');
    tabs.innerHTML = '';
    sides().forEach(function (s) {
      var btn = document.createElement('button');
      btn.textContent = s[0].toUpperCase() + s.slice(1) + ' side';
      btn.setAttribute('aria-pressed', s === side ? 'true' : 'false');
      btn.onclick = function () { setSide(s); render(); };
      tabs.appendChild(btn);
    });

    var box = $('floors');
    box.innerHTML = '';
    floors().forEach(function (f) {
      var val = Store.getFloorBags(b.id, side, f);
      var hist = (cfg.floorHistory || {})[Store.floorKey(b.id, side, f)];
      var row = document.createElement('div');
      row.className = 'floor' + (val === null ? '' : (val === 0 ? ' zero' : ' logged')) +
        (Store.night.atFloor === f ? ' current' : '');
      var fnote = Store.floorNote(b, side, f);
      row.innerHTML =
        '<div class="fname">' + floorName(f) +
          (fnote ? '<span class="fnote">' + esc(fnote) + '</span>' : '') +
          '<span class="fsub">' + (hist && hist.nights
            ? 'avg ' + (hist.bags / hist.nights).toFixed(1) + ' bags · empty ' +
              Math.round(hist.empties / hist.nights * 100) + '% of nights'
            : 'no history yet') + '</span></div>' +
        '<div class="fcount' + (val === null ? ' none' : '') + '">' +
          (val === null ? '–' : val) + '</div>' +
        '<div class="fbtns">' +
          '<button data-z="' + f + '" class="z">0</button>' +
          '<button data-minus="' + f + '">−</button>' +
          '<button data-plus="' + f + '">+</button>' +
        '</div>';
      box.appendChild(row);
    });

    var total = Store.totalFloorBags();
    $('tally').textContent = bb.bags + ' bags in ' + b.name + ' · ' + total + ' tonight';

    var carried = Store.night.bags + bb.bags;
    var room = cfg.bagCapacity - carried;
    $('advice').textContent = room > 2
      ? 'Room for about ' + room + ' more before a compactor run.'
      : 'That is a full load — dump before the next building.';

    var flagged = Store.overLimitList();
    $('overList').innerHTML = flagged.length
      ? '<b>Over the limit tonight</b>' + flagged.map(function (r) {
          return '<div class="overrow">Unit ' + esc(r.unit) + ' · ' + r.bags +
            ' bags' + (r.limit ? ' (limit ' + r.limit + ')' : '') + '</div>';
        }).join('')
      : '';
    $('overList').hidden = !flagged.length;

    var walked = Object.keys(Store.night.visited).length;
    $('shiftStat').textContent = walked + ' of ' + buildings.length +
      ' buildings walked. Closing out saves tonight so the app learns which ' +
      'floors are dead weight.';

    $('bPrev').disabled = idx === 0;
    $('bNext').disabled = idx === buildings.length - 1;
  }

  function paint() {
    $('mic').setAttribute('aria-pressed', listening ? 'true' : 'false');
    $('micLabel').textContent = listening ? 'Listening — tap to stop' : 'Start listening';
  }

  /* ---------- wiring ---------- */

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t.dataset.z) log(parseInt(t.dataset.z, 10), 0, false);
    if (t.dataset.plus) {
      var f = parseInt(t.dataset.plus, 10);
      log(f, (Store.getFloorBags(building().id, side, f) || 0) + 1, false);
    }
    if (t.dataset.minus) {
      var g = parseInt(t.dataset.minus, 10);
      var cur = Store.getFloorBags(building().id, side, g);
      if (cur !== null && cur > 0) log(g, cur - 1, false);
    }
  });

  $('mic').onclick = function () { listening ? stopListening() : startListening(); };
  $('bPrev').onclick = function () { goto(idx - 1); };
  $('bNext').onclick = function () { goto(idx + 1); };
  $('btnFinish').onclick = nextBuilding;
  $('btnDump').onclick = function () {
    Store.night.bags += Store.buildingBags(building().id).bags;
    Store.compactorRun();
    feedback(true, 'Dumped', 'bag count reset');
    render();
  };

  $('btnClose').onclick = function () {
    stopListening();
    if (!confirm('Close out tonight? Saves every floor count into history.')) return;
    var s = Store.closeNight();
    var over = (s.overLimit || []).map(function (r) {
      return '  Unit ' + r.unit + ' — ' + r.bags + ' bags';
    }).join('\n');
    alert('Night closed. ' + s.floorBags + ' bags logged across ' +
      s.buildingsWalked + ' buildings.' +
      (over ? '\n\nOver the limit:\n' + over : ''));
    location.href = 'index.html';
  };

  Store.setBuilding(building().id);
  if (sides().indexOf(side) < 0) side = sides()[0];
  render();
  announceNote();
  paint();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
})();
