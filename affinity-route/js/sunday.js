/* Affinity Route — "call out the empties" mode.
   Busy nights: assume every door has trash and only log the exceptions.
   Voice is the point (your hands are full), but tapping always works. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var cfg = Store.cfg, night = Store.night;

  var buildings = cfg.buildings.slice().sort(function (a, b) { return a.order - b.order; });
  if (!buildings.length) {
    document.querySelector('.wrap').innerHTML =
      '<h1>No route yet</h1><p class="muted">Add your buildings first.</p>' +
      '<a class="btn" href="setup.html">Route setup</a>';
    return;
  }

  Store.setAssumeOut(true);

  var idx = Math.max(0, buildings.findIndex(function (b) { return b.id === night.atBuilding; }));
  var listening = false;
  var speakBack = localStorage.getItem('affinity.speak') !== 'off';
  var lastActed = [];
  var rec = null, wakeLock = null;

  function building() { return buildings[idx]; }

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

  function say(text) {
    if (!speakBack || !window.speechSynthesis) return;
    try {
      var u = new SpeechSynthesisUtterance(text);
      u.rate = 1.25; u.volume = 1;
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

  /* ---------- logging an empty ---------- */

  function logEmpty(label, viaVoice) {
    var m = Route.matchUnits(cfg, label, building().id);

    if (m.here.length === 1) {
      var hit = m.here[0];
      var nowEmpty = Store.toggleEmpty(hit.unitId);
      if (nowEmpty) lastActed.push(hit.unitId);
      feedback(true, hit.label, nowEmpty ? 'marked empty' : 'un-marked — back to has trash');
      if (viaVoice) say(hit.label + (nowEmpty ? ' empty' : ' back on'));
      render();
      return true;
    }

    if (!m.all.length) {
      feedback(false, label, 'no door ' + label + ' on the property');
      if (viaVoice) say('no door ' + label.split('').join(' '));
      return false;
    }

    /* Number exists, just not in the building the app thinks you are in. */
    feedback(false, label, 'not in ' + building().name +
      ' — it is in ' + m.all.map(function (h) { return h.buildingName; }).join(', ') +
      '. Change building at the top.');
    if (viaVoice) say('wrong building');
    return false;
  }

  function undoLast() {
    var id = lastActed.pop();
    if (!id) return feedback(false, '—', 'nothing to undo');
    Store.undo(id);
    var hit = Store.findUnit(id);
    feedback(true, hit ? hit.unit.label : '—', 'undone — back to has trash');
    if (speakBack) say('undone');
    render();
  }

  /* ---------- voice ---------- */

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function startListening() {
    if (!SR) {
      feedback(false, 'No mic', 'This browser will not do voice. Use the number pad below.');
      return;
    }
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = 'en-US';
    rec.maxAlternatives = 3;

    rec.onresult = function (e) {
      for (var i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue;
        handleUtterance(e.results[i]);
      }
    };
    rec.onerror = function (e) {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        listening = false; paint();
        feedback(false, 'Mic blocked', 'Allow the microphone in Safari settings, or tap doors instead.');
      }
    };
    /* Safari cuts the stream off every so often; just pick it back up. */
    rec.onend = function () { if (listening) { try { rec.start(); } catch (e) {} } };

    try { rec.start(); listening = true; } catch (e) { listening = false; }
    paint();
    requestWake();
  }

  function stopListening() {
    listening = false;
    if (rec) { try { rec.stop(); } catch (e) {} }
    releaseWake();
    paint();
  }

  /* Try every alternative the recognizer offers — the top guess is often
     a homophone ("to oh for") and a lower one is the clean digits. */
  function handleUtterance(result) {
    var texts = [];
    for (var i = 0; i < result.length; i++) texts.push(result[i].transcript);

    for (var t = 0; t < texts.length; t++) {
      var cmd = Route.spokenCommand(texts[t]);
      if (cmd === 'next') { nextBuilding(); return; }
      if (cmd === 'undo') { undoLast(); return; }
    }

    for (var a = 0; a < texts.length; a++) {
      var nums = Route.parseSpokenUnits(texts[a]);
      var known = nums.filter(function (n) {
        return Route.matchUnits(cfg, n, building().id).here.length === 1;
      });
      if (known.length) {
        known.forEach(function (n) { logEmpty(n, true); });
        return;
      }
    }

    var fallback = Route.parseSpokenUnits(texts[0]);
    if (fallback.length) logEmpty(fallback[0], true);
    else feedback(false, '?', 'heard "' + texts[0] + '"');
  }

  /* Keep the screen awake while listening, or iOS locks and the mic dies. */
  function requestWake() {
    if (!navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then(function (w) { wakeLock = w; }).catch(function () {});
  }
  function releaseWake() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && listening) requestWake();
  });

  /* ---------- buildings ---------- */

  function goto(i) {
    idx = Math.max(0, Math.min(buildings.length - 1, i));
    Store.setBuilding(building().id);
    render();
  }

  function nextBuilding() {
    Store.markBuildingWalked(building().id);
    if (idx >= buildings.length - 1) {
      feedback(true, 'Done', 'That was the last building.');
      say('last building done');
      render();
      return;
    }
    goto(idx + 1);
    feedback(true, building().name, 'now walking ' + building().name);
    say(building().name);
  }

  /* ---------- render ---------- */

  function render() {
    var b = building();
    $('bName').textContent = b.name;
    var emptiesHere = Store.emptyCount(b.id);
    $('bMeta').textContent = (b.units || []).length + ' doors · ' +
      emptiesHere + ' empty · building ' + (idx + 1) + ' of ' + buildings.length +
      (night.visited[b.id] ? ' · walked' : '');

    var grid = $('grid');
    grid.innerHTML = '';
    (b.units || []).slice().sort(function (x, y) { return x.order - y.order; })
      .forEach(function (u) {
        var btn = document.createElement('button');
        btn.textContent = u.label;
        btn.className = Store.isEmpty(u.id) ? 'empty' : '';
        btn.onclick = function () {
          var nowEmpty = Store.toggleEmpty(u.id);
          if (nowEmpty) lastActed.push(u.id);
          feedback(true, u.label, nowEmpty ? 'marked empty' : 'back to has trash');
          render();
        };
        grid.appendChild(btn);
      });

    var total = Store.emptyCount();
    var walked = Object.keys(night.visited).length;
    $('tally').textContent = total + ' empties logged tonight';
    $('shiftStat').textContent = walked + ' of ' + buildings.length +
      ' buildings walked. Closing out saves tonight into each door’s history — ' +
      'that is what teaches the app which doors to skip.';

    $('bPrev').disabled = idx === 0;
    $('bNext').disabled = idx === buildings.length - 1;
  }

  function paint() {
    $('mic').setAttribute('aria-pressed', listening ? 'true' : 'false');
    $('micLabel').textContent = listening ? 'Listening — tap to stop' : 'Start listening';
  }

  /* ---------- wiring ---------- */

  $('mic').onclick = function () { listening ? stopListening() : startListening(); };
  $('bPrev').onclick = function () { goto(idx - 1); };
  $('bNext').onclick = function () { goto(idx + 1); };
  $('btnFinish').onclick = nextBuilding;
  $('btnUndo').onclick = undoLast;

  $('btnSound').onclick = function () {
    speakBack = !speakBack;
    localStorage.setItem('affinity.speak', speakBack ? 'on' : 'off');
    $('btnSound').textContent = 'Voice back: ' + (speakBack ? 'on' : 'off');
    $('btnSound').setAttribute('aria-pressed', speakBack ? 'true' : 'false');
  };
  $('btnSound').textContent = 'Voice back: ' + (speakBack ? 'on' : 'off');

  $('btnClose').onclick = function () {
    var walked = Object.keys(night.visited).length;
    if (walked < buildings.length &&
        !confirm('You have only marked ' + walked + ' of ' + buildings.length +
                 ' buildings as walked. Close out anyway? Unwalked buildings will not ' +
                 'count toward door history.')) return;
    stopListening();
    var s = Store.closeNight();
    alert('Night closed. ' + s.empty + ' empty doors logged.');
    location.href = 'index.html';
  };

  Store.setBuilding(building().id);
  render();
  paint();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
})();
