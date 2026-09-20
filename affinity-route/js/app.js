/* Affinity Route — driver screen. One door at a time, big buttons, works offline. */
(function () {
  'use strict';

  var mode = localStorage.getItem('affinity.mode') || 'smart';
  var plan = null;
  var current = null;
  var deferred = {};   // doors pushed to the end of the run

  var $ = function (id) { return document.getElementById(id); };

  function fmtAgo(ts) {
    if (!ts) return '';
    var m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    return Math.round(m / 60) + ' hr ago';
  }

  function whyLine(stop) {
    if (stop.confirmed) return 'Resident scanned — ' + fmtAgo(stop.flaggedAt);
    if (stop.confidence === 'likely') return 'Usually has trash (' + Math.round(stop.rate * 100) + '% of nights)';
    if (stop.confidence === 'rare') return 'Rarely has trash (' + Math.round(stop.rate * 100) + '%)';
    if (stop.confidence === 'new') return 'No history yet — check it';
    return 'Hit or miss (' + Math.round(stop.rate * 100) + '%)';
  }

  function pickCurrent() {
    var open = plan.stops.filter(function (s) { return !deferred[s.unitId]; });
    if (open.length) return open[0];
    var def = plan.stops.filter(function (s) { return deferred[s.unitId]; });
    return def[0] || null;
  }

  function render() {
    var cfg = Store.cfg, night = Store.night;
    $('propName').textContent = cfg.propertyName || 'Affinity Route';

    if (!cfg.buildings.length) {
      $('empty').classList.remove('hide');
      $('nowCard').classList.add('hide');
      return;
    }
    $('empty').classList.add('hide');

    plan = Route.buildPlan(cfg, night, mode);
    current = pickCurrent();

    var picked = Object.keys(night.done).filter(function (k) {
      return night.done[k].outcome === 'picked';
    }).length;

    $('sLeft').textContent = plan.stops.length;
    $('sSaved').textContent = plan.doorsSaved;
    $('sBags').textContent = night.bags;
    $('sDone').textContent = picked;

    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
      b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false');
    });

    /* current door */
    if (current) {
      $('nowCard').classList.remove('hide');
      $('nowBldg').textContent = current.buildingName +
        (deferred[current.unitId] ? ' · circling back' : '');
      $('nowDoor').textContent = current.label;
      $('nowWhy').innerHTML = '<span class="pill ' + (current.confirmed ? 'qr' : current.confidence) + '">' +
        (current.confirmed ? 'QR scan' : current.confidence) + '</span> ' + whyLine(current) +
        (current.note ? ' · ' + current.note : '');
    } else {
      $('nowCard').classList.add('hide');
    }

    /* compactor advice */
    var advice = Route.compactorAdvice(plan, night.bags, cfg.bagCapacity,
      current ? current.buildingId : null);
    if (advice.dump) {
      $('dumpCard').classList.remove('hide');
      $('dumpMsg').textContent = 'Compactor run: ' + advice.reason;
    } else {
      $('dumpCard').classList.add('hide');
    }

    /* next few doors */
    var ul = $('upNext');
    ul.innerHTML = '';
    plan.stops.slice(0, 12).forEach(function (s, i) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="door">' + s.label + '</span>' +
        '<span class="meta">' + s.buildingName + '</span>' +
        '<span class="spacer" style="flex:1"></span>' +
        '<span class="pill ' + (s.confirmed ? 'qr' : s.confidence) + '">' +
        (s.confirmed ? 'scanned' : s.confidence) + '</span>';
      if (i === 0) li.style.opacity = '1';
      ul.appendChild(li);
    });
    if (!plan.stops.length) {
      ul.innerHTML = '<li class="muted">Route clear. Nice work.</li>';
    }

    /* building overview — the big time saver is knowing what to skip entirely */
    var box = $('bldgs');
    box.innerHTML = '';
    plan.buildings.forEach(function (b) {
      var d = document.createElement('div');
      d.className = 'bhead' + (b.skipBuilding ? ' skipme' : '');
      d.innerHTML = '<b>' + b.name + '</b>' +
        (b.skipBuilding
          ? '<span class="pill skip">skip</span>'
          : '<span class="pill qr">' + b.confirmedCount + ' scanned</span>') +
        '<span class="n">' + b.openCount + ' of ' + b.totalDoors + ' doors</span>';
      box.appendChild(d);
    });

    $('shiftLine').textContent = plan.buildingsSkipped + ' buildings skipped, ' +
      plan.doorsSaved + ' doors skipped out of ' + plan.doorsTotal + '.';
  }

  function act(outcome) {
    if (!current) return;
    Store.markDone(current.unitId, outcome);
    delete deferred[current.unitId];
    render();
  }

  /* ---------- wiring ---------- */

  $('btnPicked').onclick = function () { act('picked'); };
  $('btnEmpty').onclick = function () { act('empty'); };
  $('btnSkip').onclick = function () {
    if (current) { deferred[current.unitId] = true; render(); }
  };
  $('btnDump').onclick = function () { Store.compactorRun(); render(); };
  $('btnCompactor').onclick = function () { Store.compactorRun(); render(); };

  $('btnJump').onclick = function () {
    var q = prompt('Door number?');
    if (!q) return;
    var hit = Store.allUnits().filter(function (x) {
      return x.unit.label.toLowerCase() === q.trim().toLowerCase();
    })[0];
    if (!hit) return alert('No door matching "' + q + '".');
    Store.flag(hit.unit.id, 'manual');
    deferred = {};
    render();
  };

  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
    b.onclick = function () {
      mode = b.dataset.mode;
      localStorage.setItem('affinity.mode', mode);
      render();
    };
  });

  $('btnClose').onclick = function () {
    if (!confirm('Close out tonight? This saves what each door did and starts a fresh night.')) return;
    var s = Store.closeNight();
    alert('Night closed.\n' + s.picked + ' pickups, ' + s.runs +
      ' compactor runs, ' + s.minutes + ' minutes.');
    deferred = {};
    render();
  };

  function sync(loud) {
    var line = $('syncLine');
    if (!Store.cfg.apiUrl) { line.textContent = 'offline mode — QR scans not connected'; return; }
    line.textContent = 'checking…';
    Store.pull().then(function (r) {
      line.textContent = (r.total || 0) + ' scans tonight · updated ' +
        new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      if (r.added) render();
      if (loud && !r.added) render();
      Store.flushQueue();
    }).catch(function () {
      line.innerHTML = '<span class="bad">no signal — running offline</span>';
    });
  }

  $('btnRefresh').onclick = function () { sync(true); };

  render();
  sync(false);
  setInterval(function () { sync(false); }, 90000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) sync(false);
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
