/**
 * Affinity Route — free backend on Google Apps Script + one Google Sheet.
 * No server, no monthly bill, no account for residents to make.
 *
 * Setup (about 10 minutes, do it once):
 *   1. sheets.new  -> name it "Affinity Route"
 *   2. Extensions > Apps Script, delete the sample, paste this whole file
 *   3. Run > setup   (approve the permission prompt the first time)
 *   4. Deploy > New deployment > type: Web app
 *        Execute as: Me
 *        Who has access: Anyone            <-- must be "Anyone", not "Anyone with Google account"
 *   5. Copy the /exec URL into config.js and into Route setup on your phone.
 *
 * After changing this file you must Deploy > Manage deployments > edit > New version,
 * or the old code keeps running.
 */

var SHEET = 'scans';
var HEADERS = ['at', 'night', 'property', 'unit', 'action', 'ip'];

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET) || ss.insertSheet(SHEET);
  if (sh.getLastRow() === 0) sh.appendRow(HEADERS);
  sh.setFrozenRows(1);
  return 'ready';
}

/** A shift past midnight is still the same night; 4am is the cutoff. */
function nightId(ts) {
  var d = new Date(ts - 4 * 3600 * 1000);
  var tz = Session.getScriptTimeZone();
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

function sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET) || (setup(), ss.getSheetByName(SHEET));
}

function json(obj, callback) {
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + JSON.stringify(obj) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Driver app polls this for tonight's scans. */
function doGet(e) {
  var p = (e.parameter.p || 'affinity1');
  var night = e.parameter.night || nightId(Date.now());
  var cb = e.parameter.callback;

  var sh = sheet();
  var last = sh.getLastRow();
  if (last < 2) return json({ ok: true, flags: [], now: Date.now() }, cb);

  var rows = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var state = {};
  rows.forEach(function (r) {
    if (String(r[1]) !== night || String(r[2]) !== p) return;
    var unit = String(r[3]);
    if (String(r[4]) === 'cancel') delete state[unit];
    else state[unit] = Number(r[0]);
  });

  var flags = Object.keys(state).map(function (u) {
    return { unit: u, at: state[u] };
  }).sort(function (a, b) { return a.at - b.at; });

  return json({ ok: true, night: night, flags: flags, now: Date.now() }, cb);
}

/** Residents post here from the QR page; the driver app posts its service log. */
function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {
    return json({ ok: false, error: 'bad json' });
  }

  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (err) {
    return json({ ok: false, error: 'busy' });
  }

  try {
    var sh = sheet();
    var now = Date.now();
    var p = body.p || 'affinity1';

    if (body.action === 'out' || body.action === 'cancel') {
      if (!body.unit) return json({ ok: false, error: 'no unit' });
      sh.appendRow([now, nightId(now), p, String(body.unit), body.action, '']);
      return json({ ok: true, unit: body.unit, action: body.action });
    }

    /* Driver's offline queue flushing — stored for records, not read back. */
    if (body.action === 'events' && body.events && body.events.length) {
      var rows = body.events.slice(0, 500).map(function (ev) {
        return [ev.at || now, body.night || nightId(now), p,
                String(ev.unit || ''), 'serviced:' + (ev.outcome || ''), ''];
      });
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
      return json({ ok: true, stored: rows.length });
    }

    return json({ ok: false, error: 'unknown action' });
  } finally {
    lock.releaseLock();
  }
}

/** Optional: keep the sheet from growing forever. Trigger it monthly. */
function pruneOldRows() {
  var sh = sheet();
  var cutoff = Date.now() - 120 * 24 * 3600 * 1000;
  var last = sh.getLastRow();
  if (last < 2) return;
  var vals = sh.getRange(2, 1, last - 1, 1).getValues();
  var keepFrom = 0;
  for (var i = 0; i < vals.length; i++) {
    if (Number(vals[i][0]) >= cutoff) { keepFrom = i; break; }
    keepFrom = i + 1;
  }
  if (keepFrom > 0) sh.deleteRows(2, keepFrom);
}
