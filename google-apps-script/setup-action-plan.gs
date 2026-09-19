/**
 * Rushroom Engineering & Compliance Platform — action-plan sheet helper
 * ============================================================================
 * Adds dropdowns + colour-coding to the action-plan sheet so the Status column
 * is easy to fill in and always matches what the compliance portal understands.
 *
 * HOW TO RUN (once):
 *   1. Open the "00_ACTION_PLAN_Rushroom_Compliance_Step_by_Step" Google Sheet.
 *   2. Menu: Extensions → Apps Script.
 *   3. Delete any sample code, paste THIS whole file, and click Save.
 *   4. In the function dropdown choose  setUpActionPlan  → click Run.
 *   5. First run only: Google asks you to authorise — allow it (it edits this
 *      sheet only). Re-run any time; it is safe to run repeatedly.
 *
 * What it does:
 *   • Status column  → dropdown of:  Open · In progress · Done · Blocked
 *                      (the exact values the portal reads). Existing entries are
 *                      normalised to these four first (see NORMALIZE_EXISTING).
 *   • Priority column → dropdown of the standard priorities (warns, doesn't block,
 *                      so dated notes like "High — by 2026-08-12" still work).
 *   • Colour-codes both columns to match the portal (green/amber/red/grey).
 * ============================================================================
 */

// Set to false if you would rather keep existing Status text exactly as-is
// (e.g. "Done (documented)") instead of standardising to the four values.
var NORMALIZE_EXISTING = true;

var STATUS_VALUES = ['Open', 'In progress', 'Done', 'Blocked'];
var PRIORITY_VALUES = ['Foundation', 'High', 'High — gate', 'BLOCKER', 'Medium', 'Conditional', 'Ongoing', 'Annual'];

function setUpActionPlan() {
  var sheet = findPlanSheet_();
  if (!sheet) throw new Error('Could not find a sheet with a "Status" header.');

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) throw new Error('No data rows found.');

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
    return String(h).trim().toLowerCase();
  });
  var statusCol = indexOfHeader_(headers, ['status']);
  var priorityCol = indexOfHeader_(headers, ['priority']);
  if (statusCol < 0) throw new Error('No "Status" column found.');

  var nRows = lastRow - 1; // exclude header

  // ---- Status: normalise existing text, then apply a strict dropdown --------
  var statusRange = sheet.getRange(2, statusCol + 1, nRows, 1);
  if (NORMALIZE_EXISTING) {
    var vals = statusRange.getValues();
    for (var i = 0; i < vals.length; i++) {
      var canon = canonicalStatus_(vals[i][0]);
      if (canon) vals[i][0] = canon;
    }
    statusRange.setValues(vals);
  }
  applyDropdown_(statusRange, STATUS_VALUES, !NORMALIZE_EXISTING /* allowInvalid */);

  // ---- Priority: dropdown that warns but allows dated notes -----------------
  if (priorityCol >= 0) {
    var priorityRange = sheet.getRange(2, priorityCol + 1, nRows, 1);
    applyDropdown_(priorityRange, PRIORITY_VALUES, true /* allowInvalid */);
  }

  // ---- Colour-coding to match the portal ------------------------------------
  applyColours_(sheet, statusCol + 1, priorityCol >= 0 ? priorityCol + 1 : -1, nRows);

  SpreadsheetApp.getActive().toast('Action plan set up: dropdowns + colours applied.', 'Done', 5);
}

/* ---------------- helpers ---------------- */

function findPlanSheet_() {
  var sheets = SpreadsheetApp.getActive().getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var lastCol = sheets[i].getLastColumn();
    if (lastCol < 1) continue;
    var headers = sheets[i].getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
      return String(h).trim().toLowerCase();
    });
    if (headers.indexOf('status') >= 0) return sheets[i];
  }
  return SpreadsheetApp.getActiveSheet();
}

function indexOfHeader_(headers, names) {
  for (var i = 0; i < headers.length; i++) {
    if (names.indexOf(headers[i]) >= 0) return i;
  }
  return -1;
}

// Map any free-text status to one of the four canonical values (same keyword
// logic the portal uses). Returns '' if the cell is empty.
function canonicalStatus_(raw) {
  var s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return '';
  if (/\bdone\b|complete|closed|signed/.test(s)) return 'Done';
  if (/progress|active|wip|started/.test(s)) return 'In progress';
  if (/block(?!er)|on hold|stuck/.test(s)) return 'Blocked';
  return 'Open';
}

function applyDropdown_(range, values, allowInvalid) {
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(values, true) // true = show the dropdown arrow
    .setAllowInvalid(!!allowInvalid)
    .build();
  range.setDataValidation(rule);
}

function applyColours_(sheet, statusColNum, priorityColNum, nRows) {
  var keep = sheet.getConditionalFormatRules().filter(function (rule) {
    // Drop any prior rules we added on these two columns, so re-runs don't stack.
    var ranges = rule.getRanges();
    for (var i = 0; i < ranges.length; i++) {
      var c = ranges[i].getColumn();
      if (c === statusColNum || (priorityColNum > 0 && c === priorityColNum)) return false;
    }
    return true;
  });

  var GREEN = '#d9ead3', AMBER = '#fff2cc', RED = '#f4cccc', GREY = '#efefef', ORANGE = '#fce5cd';
  var statusRange = sheet.getRange(2, statusColNum, nRows, 1);
  var rules = keep;

  rules.push(textRule_(statusRange, 'Done', GREEN));
  rules.push(textRule_(statusRange, 'progress', AMBER));
  rules.push(textRule_(statusRange, 'Block', RED));
  rules.push(textRule_(statusRange, 'Open', GREY));

  if (priorityColNum > 0) {
    var priorityRange = sheet.getRange(2, priorityColNum, nRows, 1);
    rules.push(textRule_(priorityRange, 'BLOCKER', RED));
    rules.push(textRule_(priorityRange, 'gate', ORANGE));
  }

  sheet.setConditionalFormatRules(rules);
}

function textRule_(range, contains, colour) {
  return SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains(contains)
    .setBackground(colour)
    .setRanges([range])
    .build();
}
