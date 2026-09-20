/* node test/store.test.js — exercises the empty-log scoring without a browser. */
var fs = require('fs'), vm = require('vm');

var mem = {};
var sandbox = {
  localStorage: {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
    setItem: function (k, v) { mem[k] = String(v); },
    removeItem: function (k) { delete mem[k]; }
  },
  console: console, Date: Date, JSON: JSON, Object: Object, Math: Math, String: String,
  Number: Number, Array: Array, Promise: Promise, isFinite: isFinite, parseInt: parseInt
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/../js/store.js', 'utf8'), sandbox);
var Store = sandbox.Store;

var fails = 0;
function ok(name, cond) {
  if (!cond) { fails++; console.log('FAIL  ' + name); } else console.log('pass  ' + name);
}

var b1 = Store.addBuilding('Bldg 1');
Store.setUnits(b1, Store.expandUnitList('101-104'));
var b2 = Store.addBuilding('Bldg 2');
Store.setUnits(b2, Store.expandUnitList('201-202'));

ok('ranges expand', Store.allUnits().length === 6);
ok('ranges keep leading zeros', Store.expandUnitList('008-010').join() === '008,009,010');
ok('mixed list parses', Store.expandUnitList('101-103, 110').join() === '101,102,103,110');

Store.setAssumeOut(true);
Store.toggleEmpty(b1 + '.102');
ok('toggle marks empty', Store.isEmpty(b1 + '.102') === true);
ok('toggle again clears it', Store.toggleEmpty(b1 + '.102') === false && !Store.isEmpty(b1 + '.102'));

Store.toggleEmpty(b1 + '.102');
Store.toggleEmpty(b1 + '.104');
ok('empties counted per building', Store.emptyCount(b1) === 2 && Store.emptyCount(b2) === 0);
ok('empties counted overall', Store.emptyCount() === 2);

/* Only building 1 was actually walked. */
Store.markBuildingWalked(b1);
Store.closeNight();

var h = Store.cfg.history;
ok('walked + untouched door scores as had-trash',
   h[b1 + '.101'].nights === 1 && h[b1 + '.101'].out === 1);
ok('called-out door scores as empty',
   h[b1 + '.102'].nights === 1 && h[b1 + '.102'].out === 0);
ok('building you never walked is not scored at all', !h[b2 + '.201']);

/* Second night: 102 empty again, everything else out. */
Store.setAssumeOut(true);
Store.toggleEmpty(b1 + '.102');
Store.markBuildingWalked(b1);
Store.closeNight();

var Route = require('../js/route.js');
ok('repeat empty drives the hit rate to zero',
   Route.hitRate(Store.cfg.history[b1 + '.102']) === 0);
ok('reliable door holds at 100%',
   Route.hitRate(Store.cfg.history[b1 + '.101']) === 1);

/* Two nights is not enough to act on — the app should still check it. */
ok('two nights is still "new", so smart mode keeps checking it',
   Route.confidence(Store.cfg.history[b1 + '.102']) === 'new');
Store.setAssumeOut(true);
Store.toggleEmpty(b1 + '.102');
Store.markBuildingWalked(b1);
Store.closeNight();
ok('three nights of nothing marks the door skippable',
   Route.confidence(Store.cfg.history[b1 + '.102']) === 'rare');

var plan = Route.buildPlan(Store.cfg, Store.night, 'smart');
ok('smart mode now drops that door',
   plan.stops.map(function (s) { return s.unitId; }).indexOf(b1 + '.102') === -1);
ok('smart mode keeps the reliable doors', plan.stops.length === 5);

console.log(fails ? '\n' + fails + ' FAILED' : '\nall good');
process.exit(fails ? 1 : 0);
