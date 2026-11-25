/**
 * Admin.gs — HighCall After Dark admin area (Google Apps Script web app).
 * Access: Google sign-in restricted to the highcallva.com domain (deployment setting)
 *         + the ADMIN_EMAILS allowlist (checked on page load AND on every server call).
 */

var PRIVATE_KEYS = ['clientKey', 'finalizeToken', 'uploadUrl'];

function doGet() {
  var email = currentEmail_();
  if (!isAdmin_(email)) {
    var who = email ? 'You’re signed in as ' + escapeHtml_(email) + '.' : 'Sign in with your HighCall VA Google account.';
    return HtmlService.createHtmlOutput(
      '<div style="font-family:system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:24px;border:3px solid #0f2a44;border-radius:14px">' +
      '<h1 style="margin-top:0;color:#14385e">Access denied</h1><p>This area is only for the HighCall After Dark contest team. ' + who +
      '</p><p>If you need access, ask the contest administrator to add your email.</p></div>'
    ).setTitle('Access denied');
  }
  var t = HtmlService.createTemplateFromFile('Admin');
  t.adminEmail = email;
  return t.evaluate()
    .setTitle('HighCall After Dark — Admin')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function currentEmail_() {
  try { return String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { return ''; }
}

function isAdmin_(email) {
  if (!email) return false;
  return CONFIG.ADMIN_EMAILS.map(function (e) { return String(e).toLowerCase().trim(); }).indexOf(email) !== -1;
}

function requireAdmin_() {
  var email = currentEmail_();
  if (!isAdmin_(email)) throw new Error('Access denied.');
  return email;
}

function publicRecord_(o) {
  var r = {};
  COLUMNS.forEach(function (c) { if (PRIVATE_KEYS.indexOf(c[0]) === -1) r[c[0]] = o[c[0]]; });
  return r;
}

function allRecords_() {
  var sh = getSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, NUM_COLS).getDisplayValues();
  return vals.map(function (row) {
    var o = {};
    COLUMNS.forEach(function (c, i) { o[c[0]] = row[i]; });
    return o;
  }).filter(function (o) { return o.reference; });
}

/** Called from the page: every submission without private columns. */
function listSubmissions() {
  requireAdmin_();
  var records = allRecords_().map(publicRecord_);
  records.sort(function (a, b) { return String(b.registeredIso).localeCompare(String(a.registeredIso)); });
  return {
    records: records,
    statuses: ADMIN_STATUSES,
    generatedAt: formatPHT_(new Date())
  };
}

/** Update an entry's status and/or admin notes. */
function updateEntry(reference, changes) {
  var email = requireAdmin_();
  reference = String(reference || '');
  if (!/^HCAD-[A-Z0-9]{6}$/.test(reference)) throw new Error('Invalid reference.');
  changes = changes || {};

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('The sheet is busy. Try again in a moment.');
  try {
    var sh = getSheet_();
    var row = findRow_(sh, 'reference', reference);
    if (!row) throw new Error('Entry not found.');
    var rec = readRow_(sh, row);

    if (changes.status !== undefined && changes.status !== rec.status) {
      if (ADMIN_STATUSES.indexOf(changes.status) === -1) throw new Error('Unknown status.');
      if (COMPLETE_STATUSES.indexOf(rec.status) === -1) throw new Error('Only completed entries can be reviewed.');
      rec.status = changes.status;
      rec.statusUpdatedBy = email;
      rec.statusUpdatedAt = formatPHT_(new Date());
    }
    if (changes.adminNotes !== undefined) {
      rec.adminNotes = String(changes.adminNotes).slice(0, 5000);
    }
    writeRow_(sh, row, rec);
    SpreadsheetApp.flush();
    return publicRecord_(rec);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Permanently remove an entry: moves its video to Drive trash (recoverable for 30 days)
 * and deletes its row from the Sheet (recoverable through the Sheet's version history).
 */
function deleteEntry(reference) {
  var email = requireAdmin_();
  reference = String(reference || '');
  if (!/^HCAD-[A-Z0-9]{6}$/.test(reference)) throw new Error('Invalid reference.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('The sheet is busy. Try again in a moment.');
  try {
    var sh = getSheet_();
    var row = findRow_(sh, 'reference', reference);
    if (!row) throw new Error('Entry not found. It may already have been deleted.');
    var rec = readRow_(sh, row);

    var videoTrashed = false;
    if (rec.driveFileId) {
      try {
        var file = DriveApp.getFileById(rec.driveFileId);
        var inFolder = false, parents = file.getParents();
        while (parents.hasNext()) { if (parents.next().getId() === CONFIG.VIDEO_FOLDER_ID) inFolder = true; }
        if (inFolder) { file.setTrashed(true); videoTrashed = true; }
      } catch (e) {
        console.warn('Could not trash video for ' + reference + ': ' + e);
      }
    }
    sh.deleteRow(row);
    SpreadsheetApp.flush();
    console.log('Entry ' + reference + ' (' + rec.fullName + ', ' + rec.email + ') deleted by ' + email + '. Video trashed: ' + videoTrashed);
    return { reference: reference, videoTrashed: videoTrashed, hadVideo: !!rec.driveFileId };
  } finally {
    lock.releaseLock();
  }
}

var CSV_FIELDS = [
  'reference', 'status', 'registeredAt', 'receivedAt', 'fullName', 'email', 'entryTitle', 'character',
  'description', 'fileName', 'fileSizeMB', 'graceUsed', 'driveLink', 'adminNotes', 'statusUpdatedBy', 'statusUpdatedAt'
];

function buildCsv_(includeIncomplete) {
  var headerOf = {};
  COLUMNS.forEach(function (c) { headerOf[c[0]] = c[1]; });
  var records = allRecords_().filter(function (r) {
    return includeIncomplete || COMPLETE_STATUSES.indexOf(r.status) !== -1;
  });
  records.sort(function (a, b) { return String(a.registeredIso).localeCompare(String(b.registeredIso)); });
  var cell = function (v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;       // spreadsheet formula guard
    return '"' + s.replace(/"/g, '""') + '"';
  };
  var lines = [CSV_FIELDS.map(function (k) { return cell(headerOf[k]); }).join(',')];
  records.forEach(function (r) { lines.push(CSV_FIELDS.map(function (k) { return cell(r[k]); }).join(',')); });
  return { csv: '\uFEFF' + lines.join('\r\n'), count: records.length };
}

function exportCsv(includeIncomplete) {
  requireAdmin_();
  var out = buildCsv_(!!includeIncomplete);
  out.filename = 'after-dark-submissions-' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmm') + '.csv';
  return out;
}

/** Fallback: save the CSV next to the submissions sheet (same restricted location). */
function saveCsvToDrive(includeIncomplete) {
  requireAdmin_();
  var out = buildCsv_(!!includeIncomplete);
  var name = 'after-dark-submissions-' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmm') + '.csv';
  var parents = DriveApp.getFileById(CONFIG.SPREADSHEET_ID).getParents();
  var folder = parents.hasNext() ? parents.next() : DriveApp.getFolderById(CONFIG.VIDEO_FOLDER_ID);
  var file = folder.createFile(name, out.csv, MimeType.CSV);
  return { url: file.getUrl(), name: name, count: out.count };
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
