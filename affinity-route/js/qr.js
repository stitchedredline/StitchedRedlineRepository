/* Affinity Route — printable QR tags, one per door. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var cfg = Store.cfg;

  var savedBase = localStorage.getItem('affinity.base') ||
    location.href.replace(/qr\.html.*$/, '');
  $('base').value = savedBase;

  var sel = $('which');
  sel.innerHTML = '<option value="">All buildings</option>' +
    cfg.buildings.slice().sort(function (a, b) { return a.order - b.order; })
      .map(function (b) {
        return '<option value="' + b.id + '">' + b.name + ' (' + (b.units || []).length + ')</option>';
      }).join('');

  function tagUrl(base, unitId) {
    var api = cfg.apiUrl || window.AFFINITY_API || '';
    var u = base.replace(/\/?$/, '/') + 'out.html?p=' +
      encodeURIComponent(cfg.propertyId) + '&u=' + encodeURIComponent(unitId);
    /* Carry the endpoint in the QR so a tag still works if config.js is stale. */
    if (api) u += '&api=' + encodeURIComponent(api);
    return u;
  }

  $('btnGen').onclick = function () {
    var base = $('base').value.trim();
    if (!base) return alert('Enter the web address where this app is hosted.');
    localStorage.setItem('affinity.base', base);

    var pick = sel.value;
    var box = $('tags');
    box.innerHTML = '';

    var units = Store.allUnits().filter(function (x) {
      return !pick || x.building.id === pick;
    });
    if (!units.length) return alert('No doors yet — add them in Route setup first.');

    units.forEach(function (x) {
      var div = document.createElement('div');
      div.className = 'tag';
      div.innerHTML = '<div class="t1">' + $('headline').value + '</div>' +
        '<div class="t2">' + x.building.name + ' · ' + x.unit.label + '</div>' +
        '<canvas></canvas>' +
        '<div class="t3">Tap once when your bag is by the door.</div>';
      box.appendChild(div);
      QRCode.toCanvas(div.querySelector('canvas'), tagUrl(base, x.unit.id),
        { width: 380, margin: 1, errorCorrectionLevel: 'M' }, function (err) {
          if (err) div.querySelector('.t3').textContent = 'QR failed: ' + err.message;
        });
    });
  };

  $('btnPrint').onclick = function () { window.print(); };
})();
