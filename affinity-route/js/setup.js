/* Affinity Route — one-time route builder. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var cfg = Store.cfg;

  if (!cfg.propertyName && window.AFFINITY_PROPERTY_NAME) cfg.propertyName = window.AFFINITY_PROPERTY_NAME;
  if (!cfg.apiUrl && window.AFFINITY_API) cfg.apiUrl = window.AFFINITY_API;

  $('propName').value = cfg.propertyName || '';
  $('apiUrl').value = cfg.apiUrl || '';
  $('bagCap').value = cfg.bagCapacity || 12;

  $('btnSaveCfg').onclick = function () {
    cfg.propertyName = $('propName').value.trim();
    cfg.apiUrl = $('apiUrl').value.trim();
    cfg.bagCapacity = Math.max(1, parseInt($('bagCap').value, 10) || 12);
    Store.saveCfg();
    $('btnSaveCfg').textContent = 'Saved ✓';
    setTimeout(function () { $('btnSaveCfg').textContent = 'Save'; }, 1500);
  };

  function pinNow(cb) {
    if (!navigator.geolocation) return alert('This phone will not share location.');
    $('pinLine').textContent = 'Getting location…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      cb({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) });
      $('pinLine').textContent = 'Pinned (±' + Math.round(pos.coords.accuracy) + 'm).';
      Store.saveCfg();
      render();
    }, function () {
      $('pinLine').textContent = 'Could not get a fix. Step outside and try again.';
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }

  $('btnPinComp').onclick = function () { pinNow(function (p) { cfg.compactorPin = p; }); };

  $('btnOptimize').onclick = function () {
    var ordered = Route.optimizeOrder(cfg.buildings, cfg.compactorPin);
    if (ordered === cfg.buildings || ordered.length !== cfg.buildings.length) {
      return alert('Pin at least 3 buildings first.');
    }
    Store.reorderBuildings(ordered.map(function (b) { return b.id; }));
    alert('Re-ordered by shortest walk. Check it against what you know — trust your feet over the math.');
    render();
  };

  $('btnAdd').onclick = function () {
    var name = prompt('Building name or number?');
    if (name === null) return;
    Store.addBuilding(name.trim() || undefined);
    render();
  };

  $('btnBulk').onclick = function () {
    var list = Store.parseRouteText($('bulk').value);
    if (!list.length) {
      $('bulkMsg').textContent = 'Nothing parsed. Each line needs a building number, ' +
        'a colon, then the units: 2202: 101-108, 201-208';
      return;
    }
    var doors = list.reduce(function (n, b) { return n + b.units.length; }, 0);
    if (cfg.buildings.length &&
        !confirm('Replace your current route with ' + list.length + ' buildings / ' +
                 doors + ' doors? Door history is kept.')) return;
    Store.importRoute(list);
    $('bulkMsg').textContent = list.length + ' buildings, ' + doors + ' doors loaded.';
    render();
  };

  $('btnSeed').onclick = function () {
    $('bulkMsg').textContent = 'Loading route.json…';
    Store.loadSeed().then(function (r) {
      $('bulkMsg').textContent = 'Loaded ' + r.buildings + ' buildings, ' + r.doors + ' doors.';
      $('propName').value = Store.cfg.propertyName || '';
      render();
    }).catch(function (e) {
      $('bulkMsg').textContent = 'Could not load route.json — ' + e.message;
    });
  };

  /* Prefill the paste box with whatever route is already loaded, so editing
     the whole property is one text box instead of nineteen cards. */
  function fillBulk() {
    $('bulk').value = cfg.buildings.slice().sort(function (a, b) { return a.order - b.order; })
      .map(function (b) {
        return b.name + ': ' + (b.units || []).map(function (u) { return u.label; }).join(', ');
      }).join('\n');
  }

  /* A throwaway 19-building property so you can see the app work before
     spending ten minutes typing your real doors in. */
  $('btnDemo').onclick = function () {
    if (cfg.buildings.length && !confirm('This replaces the route you have. Continue?')) return;
    cfg.buildings = [];
    for (var i = 1; i <= 19; i++) {
      var id = Store.addBuilding('Bldg ' + i);
      Store.setUnits(id, Store.expandUnitList('101-108, 201-208'));
    }
    Store.saveCfg();
    render();
    fillBulk();
    alert('Sample route loaded: 19 buildings, 304 doors. Delete it and build your real one when you have time.');
  };

  function render() {
    var box = $('list');
    box.innerHTML = '';
    cfg.buildings.slice().sort(function (a, b) { return a.order - b.order; })
      .forEach(function (b, i, arr) {
        var card = document.createElement('div');
        card.className = 'card';
        card.innerHTML =
          '<div class="bhead" style="margin:0 0 10px">' +
            '<b>' + (i + 1) + '. ' + b.name + '</b>' +
            (b.pin ? '<span class="pill likely">pinned</span>' : '') +
            '<span class="n">' + (b.units || []).length + ' doors</span>' +
          '</div>' +
          '<label>Unit numbers, in walking order</label>' +
          '<textarea data-units="' + b.id + '">' +
            (b.units || []).map(function (u) { return u.label; }).join(', ') +
          '</textarea>' +
          '<div class="row">' +
            '<button class="btn sec sm" data-save="' + b.id + '">Save doors</button>' +
            '<button class="btn sec sm" data-up="' + b.id + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
            '<button class="btn sec sm" data-down="' + b.id + '"' + (i === arr.length - 1 ? ' disabled' : '') + '>↓</button>' +
            '<button class="btn sec sm" data-pin="' + b.id + '">Pin</button>' +
            '<button class="btn danger sm" data-del="' + b.id + '">Delete</button>' +
          '</div>';
        box.appendChild(card);
      });

    if (!cfg.buildings.length) {
      box.innerHTML = '<p class="muted">No buildings yet. Add your first one below.</p>';
    }
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    var order = cfg.buildings.slice().sort(function (a, b) { return a.order - b.order; })
      .map(function (b) { return b.id; });

    if (t.dataset.save) {
      var ta = document.querySelector('[data-units="' + t.dataset.save + '"]');
      Store.setUnits(t.dataset.save, Store.expandUnitList(ta.value));
      t.textContent = 'Saved ✓';
      setTimeout(render, 900);
    }
    if (t.dataset.up || t.dataset.down) {
      var id = t.dataset.up || t.dataset.down;
      var i = order.indexOf(id);
      var j = t.dataset.up ? i - 1 : i + 1;
      if (j < 0 || j >= order.length) return;
      order.splice(j, 0, order.splice(i, 1)[0]);
      Store.reorderBuildings(order);
      render();
    }
    if (t.dataset.pin) {
      var b = cfg.buildings.filter(function (x) { return x.id === t.dataset.pin; })[0];
      pinNow(function (p) { b.pin = p; });
    }
    if (t.dataset.del) {
      if (!confirm('Delete this building and its doors?')) return;
      cfg.buildings = cfg.buildings.filter(function (x) { return x.id !== t.dataset.del; });
      Store.saveCfg();
      render();
    }
  });

  $('btnExport').onclick = function () { $('dump').value = Store.exportAll(); };
  $('btnImport').onclick = function () {
    try { Store.importAll($('dump').value); alert('Restored.'); location.reload(); }
    catch (err) { alert('That text is not a valid backup.'); }
  };

  render();
  fillBulk();
})();
