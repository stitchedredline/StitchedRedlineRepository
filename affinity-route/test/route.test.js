/* Plain node, no dependencies:  node test/route.test.js  */
var Route = require('../js/route.js');
var fails = 0;
function ok(name, cond) {
  if (!cond) { fails++; console.log('FAIL  ' + name); }
  else console.log('pass  ' + name);
}

var cfg = {
  buildings: [
    { id: 'B1', name: 'Bldg 1', order: 1, units: [
      { id: 'B1.101', label: '101', order: 1 },
      { id: 'B1.102', label: '102', order: 2 },
      { id: 'B1.103', label: '103', order: 3 }
    ]},
    { id: 'B2', name: 'Bldg 2', order: 2, units: [
      { id: 'B2.201', label: '201', order: 1 },
      { id: 'B2.202', label: '202', order: 2 }
    ]}
  ],
  history: {
    'B1.101': { nights: 10, out: 9 },   // likely
    'B1.102': { nights: 10, out: 1 },   // rare
    'B1.103': { nights: 10, out: 5 },   // mixed
    'B2.201': { nights: 10, out: 0 },   // rare
    'B2.202': { nights: 10, out: 0 }    // rare
  }
};
var night = { flags: { 'B1.103': { at: 1, src: 'qr' } }, done: {}, bags: 0, runs: [] };

var sweep = Route.buildPlan(cfg, night, 'sweep');
ok('sweep visits every door', sweep.stops.length === 5);

var confirmed = Route.buildPlan(cfg, night, 'confirmed');
ok('QR-only visits just the scanned door', confirmed.stops.length === 1 &&
   confirmed.stops[0].unitId === 'B1.103');
ok('QR-only skips both doors in an empty building',
   confirmed.buildings[1].skipBuilding === true);

var smart = Route.buildPlan(cfg, night, 'smart');
var ids = smart.stops.map(function (s) { return s.unitId; });
ok('smart keeps the scan and the reliable door', ids.indexOf('B1.103') > -1 && ids.indexOf('B1.101') > -1);
ok('smart drops doors that never put trash out', ids.indexOf('B2.201') === -1);
ok('smart reports doors saved', smart.doorsSaved === 3);

ok('walk order is preserved', sweep.stops[0].unitId === 'B1.101' &&
   sweep.stops[4].unitId === 'B2.202');

var night2 = { flags: {}, done: { 'B1.101': { outcome: 'picked' } }, bags: 0, runs: [] };
var after = Route.buildPlan(cfg, night2, 'sweep');
ok('serviced doors drop off the list', after.stops.length === 4);

/* unknown doors are checked, not assumed empty */
var freshCfg = { buildings: cfg.buildings, history: {} };
ok('brand new route sweeps everything under smart mode',
   Route.buildPlan(freshCfg, { flags: {}, done: {} }, 'smart').stops.length === 5);

/* compactor advice */
ok('plenty of room -> keep going',
   Route.compactorAdvice(sweep, 3, 12, 'B1').dump === false);
ok('hands full -> dump now',
   Route.compactorAdvice(sweep, 12, 12, 'B1').dump === true);
var nearDone = Route.buildPlan(cfg, { flags: {}, done: { 'B2.201': { outcome: 'picked' } } }, 'sweep');
ok('nearly full but one door left here -> finish it',
   Route.compactorAdvice(nearDone, 11, 12, 'B2').dump === false);
ok('nearly full and a whole building left -> dump first',
   Route.compactorAdvice(sweep, 11, 12, 'B2').dump === true);

/* geo */
var a = { lat: 35.2271, lng: -80.8431 };
var b = { lat: 35.2280, lng: -80.8431 };
var d = Route.haversine(a, b);
ok('haversine returns sane feet (~328)', d > 300 && d < 360);

var pts = [
  { id: 'far',  pin: { lat: 35.2300, lng: -80.8431 } },
  { id: 'near', pin: { lat: 35.2272, lng: -80.8431 } },
  { id: 'mid',  pin: { lat: 35.2285, lng: -80.8431 } }
];
var home = { lat: 35.2271, lng: -80.8431 };
var order = Route.optimizeOrder(pts, home).map(function (x) { return x.id; });
ok('optimizer walks nearest first', order[0] === 'near' && order[2] === 'far');

/* ---- floors and bag counts, spoken the way the route is actually walked ---- */

function callOut(text, top, state) {
  return Route.applyFloorCall(Route.parseFloorCall(text, top), state || {});
}

var left = callOut('Top floor, left side, third floor, zero bags, second floor, two bags, ' +
                   'bottom floor, three bags.', 3);
ok('a whole side in one breath yields three floors', left.entries.length === 3);
ok('side is picked up', left.entries.every(function (e) { return e.side === 'left'; }));
ok('top/third floor reads zero', left.entries[0].floor === 3 && left.entries[0].bags === 0);
ok('second floor reads two', left.entries[1].floor === 2 && left.entries[1].bags === 2);
ok('bottom floor is floor 1', left.entries[2].floor === 1 && left.entries[2].bags === 3);

var right = callOut('right side, top floor, three bags, second floor, three bags, ' +
                    'bottom floor, four bags', 3);
ok('the other side parses the same way', right.entries.length === 3);
ok('"top floor" resolves against the building height',
   right.entries[0].floor === 3 && right.entries[0].bags === 3);
ok('right side is carried across every floor',
   right.entries.every(function (e) { return e.side === 'right'; }));
ok('totals add up', right.entries.reduce(function (n, e) { return n + e.bags; }, 0) === 10);

ok('a bare trailing number is the bag count',
   callOut('third floor zero', 3).entries[0].bags === 0);
ok('"nothing" counts as zero',
   callOut('second floor nothing', 3).entries[0].bags === 0);
ok('"floor three" word order works',
   callOut('floor three two bags', 3).entries[0].floor === 3);
ok('a four-storey building puts "top" on four',
   callOut('top floor one bag', 4).entries[0].floor === 4);
ok('side carries over from where you already were',
   callOut('second floor two bags', 3, { side: 'right' }).entries[0].side === 'right');
ok('a floor with no count logs nothing',
   callOut('top floor, left side', 3).entries.length === 0);
ok('a side-only call still reports the side',
   callOut('right side', 3).side === 'right');

/* ---- the count comes before the floor: "four on the top floor" ---- */

var pre = callOut('four on the top floor, two on the second floor, six on the bottom floor', 3);
ok('count-before-floor yields every floor', pre.entries.length === 3);
ok('"four on the top floor" is 4 bags on floor 3',
   pre.entries[0].floor === 3 && pre.entries[0].bags === 4);
ok('"two on the second floor" is 2 bags on floor 2',
   pre.entries[1].floor === 2 && pre.entries[1].bags === 2);
ok('"six on the bottom floor" is 6 bags on floor 1',
   pre.entries[2].floor === 1 && pre.entries[2].bags === 6);
ok('filler words do not break the phrase',
   callOut('we got four up on the top floor', 3).entries[0].bags === 4);
ok('count-before-floor mixes with count-after-floor',
   callOut('four on the top floor, second floor two bags', 3).entries
     .map(function (e) { return e.bags; }).join() === '4,2');

/* ---- a side named at the end still describes the whole call ---- */

var late = callOut('four on the top floor, two on the second floor, ' +
                   'six on the bottom floor, left side', 3, { side: 'right' });
ok('a side named last claims every count in the breath',
   late.entries.length === 3 && late.entries.every(function (e) { return e.side === 'left'; }));
ok('two sides in one breath still split positionally',
   callOut('left side top floor two bags, right side top floor five bags', 3)
     .entries.map(function (e) { return e.side; }).join() === 'left,right');

/* ---- an aside about one door, spoken in the same breath ---- */

var aside = 'four on the top floor, two on the second floor, six on the bottom floor, ' +
            'left side, unit 1318 has six bags, too many. We only have a three bag limit.';
var over = Route.parseOverLimit(aside);
ok('the door number is read out of the aside', over && over.unit === '1318');
ok('the count is what was put out, not the limit', over && over.bags === 6);
ok('a limit with no door named is a rule, not a report',
   Route.parseOverLimit('we only have a three bag limit') === null);
ok('the limit clause never overwrites the real count',
   Route.parseOverLimit('unit 1318 has six bags. the limit is three bags').bags === 6);
ok('a door number with no "unit" in front is not an aside',
   Route.parseOverLimit('six on the bottom floor') === null);
ok('spoken door numbers work too',
   Route.parseOverLimit('apartment thirteen eighteen has six bags').unit === '1318');
ok('a terse aside works', Route.parseOverLimit('unit 1318 six bags').bags === 6);

var stripped = callOut(Route.stripUnitAside(aside), 3, { side: 'right' });
ok('stripping the aside leaves the floor counts intact',
   stripped.entries.map(function (e) { return e.bags; }).join() === '4,2,6');
ok('the aside never becomes a phantom floor count', stripped.entries.length === 3);
ok('the side from the aside call still lands',
   stripped.entries.every(function (e) { return e.side === 'left'; }));

/* ---- "top" and "middle" name a floor without the word "floor" ---- */

var bare = callOut('left side, three on the top, two in the middle, six on the bottom floor', 3);
ok('a bare "top" still names the top floor',
   bare.entries[0].floor === 3 && bare.entries[0].bags === 3);
ok('"the middle" is the middle floor',
   bare.entries[1].floor === 2 && bare.entries[1].bags === 2);
ok('a bare floor word does not swallow the rest of the call',
   bare.entries.length === 3 && bare.entries[2].floor === 1 && bare.entries[2].bags === 6);
ok('a floor named at the very end still counts',
   callOut('six on the bottom', 3).entries[0].floor === 1);
ok('"middle" scales with the building', callOut('two in the middle', 5).entries.length === 0 ||
   Route.parseFloorCall('two in the middle', 5)
     .filter(function (e) { return e.type === 'floor'; })[0].value === 3);

/* ---- the count can lead its floor: "three bags on the top floor" ---- */

var bagsFirst = callOut('three bags on the top floor, two bags on the second floor', 3);
ok('a count spoken before its floor lands on that floor',
   bagsFirst.entries[0].floor === 3 && bagsFirst.entries[0].bags === 3);
ok('and the next one does not stick to the previous floor',
   bagsFirst.entries[1].floor === 2 && bagsFirst.entries[1].bags === 2);
ok('"zero on the bottom floor" reads as a count, not a floor',
   callOut('zero on the bottom floor', 3).entries[0].bags === 0);
ok('a bare count with no floor named lands on the floor you are on',
   callOut('three bags', 3, { side: 'left', floor: 2 }).entries[0].floor === 2);

console.log(fails ? '\n' + fails + ' FAILED' : '\nall good');
process.exit(fails ? 1 : 0);
