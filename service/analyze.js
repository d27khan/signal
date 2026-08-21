'use strict';

/**
 * Cross-references ground-truth fault windows (data/fault_log.jsonl)
 * against what actually paged (data/alerts_log.<phase>.jsonl) to produce
 * real before/after numbers: alert volume, false positive rate, and
 * fault detection rate. No manual judgment calls about whether an alert
 * "seemed" noisy — a fault either overlapped a firing alert or it didn't.
 *
 * Usage: node analyze.js <phase> [--grace-ms=15000] [--window-mins=N] [--since=<ISO8601>]
 *
 * --since is for excluding a phase-transition artifact: an alert that
 * started firing under the previous phase's rules right before
 * switch-phase.sh ran will still show up in this phase's log until it
 * resolves. Pass an ISO timestamp just after the confirmed rule switch
 * to cut it out of the comparison.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const phase = process.argv[2];
if (!phase) {
  console.error('Usage: node analyze.js <phase> [--grace-ms=15000] [--window-mins=N] [--since=<ISO8601>]');
  process.exit(1);
}
const graceArg = process.argv.find((a) => a.startsWith('--grace-ms='));
const GRACE_MS = graceArg ? Number(graceArg.split('=')[1]) : 15000;
const windowArg = process.argv.find((a) => a.startsWith('--window-mins='));
const WINDOW_MINS = windowArg ? Number(windowArg.split('=')[1]) : null;
const sinceArg = process.argv.find((a) => a.startsWith('--since='));
const SINCE_TS = sinceArg ? new Date(sinceArg.split('=')[1]).getTime() : null;

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function buildFaultWindows(events) {
  const windows = [];
  const openByName = {};
  for (const e of events) {
    if (e.event === 'fault_start') {
      openByName[e.fault] = e.ts;
    } else if (e.event === 'fault_end') {
      const start = openByName[e.fault];
      if (start != null) {
        windows.push({ fault: e.fault, start, end: e.ts, groundTruth: groundTruthOf(e.fault) });
        delete openByName[e.fault];
      }
    }
  }
  // Any still-open fault at time of analysis: close it at "now" so it's
  // not silently dropped from the report.
  const now = Date.now();
  for (const [fault, start] of Object.entries(openByName)) {
    windows.push({ fault, start, end: now, stillOpen: true, groundTruth: groundTruthOf(fault) });
  }
  return windows.sort((a, b) => a.start - b.start);
}

// `blip` is deliberately sub-SLO noise (see service/faults.js): a
// well-tuned pipeline should NOT alert on it. So it's excluded from the
// "must be detected" fault set, and an alert that fires only during a
// blip (no overlapping real fault) counts as a false positive, not a
// catch.
const NOISE_FAULTS = new Set(['blip']);
function groundTruthOf(faultName) {
  return NOISE_FAULTS.has(faultName) ? 'noise' : 'real';
}

let faultEvents = readJsonl(path.join(DATA_DIR, 'fault_log.jsonl'));
let alertEvents = readJsonl(path.join(DATA_DIR, `alerts_log.${phase}.jsonl`));

if (WINDOW_MINS) {
  const cutoff = Date.now() - WINDOW_MINS * 60 * 1000;
  faultEvents = faultEvents.filter((e) => e.ts >= cutoff);
  alertEvents = alertEvents.filter((e) => e.ts >= cutoff);
}
if (SINCE_TS) {
  faultEvents = faultEvents.filter((e) => e.ts >= SINCE_TS);
  // Drop any alert episode whose startsAt predates the cutoff entirely
  // (not just individual events), since it belongs to the prior phase's
  // rule set even if it resolved after the cutoff.
  const preCutoffKeys = new Set(
    alertEvents.filter((a) => new Date(a.startsAt).getTime() < SINCE_TS).map((a) => `${a.alertname}|${a.startsAt}|${a.route || ''}`)
  );
  alertEvents = alertEvents.filter((a) => !preCutoffKeys.has(`${a.alertname}|${a.startsAt}|${a.route || ''}`));
}

const faultWindows = buildFaultWindows(faultEvents);

// Build one "episode" per (alertname, startsAt, route): Alertmanager
// keeps the same startsAt for as long as an alert stays continuously
// firing, which — when faults land close together — can span more than
// one fault window. Point-checking just startsAt would wrongly call the
// later window "missed" even though the alert was firing throughout it.
// So each episode's *full interval* [startsAt, lastSeenOrResolved] is
// what gets checked for overlap, not just its start instant.
const episodesByKey = new Map();
for (const a of alertEvents) {
  const key = `${a.alertname}|${a.startsAt}|${a.route || ''}`;
  const startTs = new Date(a.startsAt).getTime();
  let ep = episodesByKey.get(key);
  if (!ep) {
    ep = { alertname: a.alertname, severity: a.severity, route: a.route, startsAt: a.startsAt, start: startTs, end: startTs, resolved: false };
    episodesByKey.set(key, ep);
  }
  if (a.status === 'resolved') {
    ep.resolved = true;
    ep.end = Math.max(ep.end, a.ts);
  } else {
    ep.end = Math.max(ep.end, a.ts);
  }
}
const alertInstances = [...episodesByKey.values()];

const realWindows = faultWindows.filter((w) => w.groundTruth === 'real');
const noiseWindows = faultWindows.filter((w) => w.groundTruth === 'noise');

function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd + GRACE_MS && aEnd >= bStart - GRACE_MS;
}

function overlapsWindows(ep, windows) {
  return windows.some((w) => intervalsOverlap(ep.start, ep.end, w.start, w.end));
}

// True positive requires overlap with a REAL fault. Firing only during
// (or with no relation to) a noise blip is a false positive — that's
// the whole point of the blip fault type.
let truePositives = 0;
let falsePositives = 0;
for (const a of alertInstances) {
  if (overlapsWindows(a, realWindows)) truePositives++;
  else falsePositives++;
}
const falsePositivesOnNoise = alertInstances.filter((a) => !overlapsWindows(a, realWindows) && overlapsWindows(a, noiseWindows)).length;
const falsePositivesUnexplained = falsePositives - falsePositivesOnNoise;

function windowHasAlert(w) {
  return alertInstances.some((ep) => intervalsOverlap(ep.start, ep.end, w.start, w.end));
}

const detectedWindows = realWindows.filter(windowHasAlert);
const missedWindows = realWindows.filter((w) => !windowHasAlert(w));

const bySeverity = {};
for (const a of alertInstances) {
  const sev = a.severity || 'unlabeled';
  bySeverity[sev] = (bySeverity[sev] || 0) + 1;
}

const byAlertname = {};
for (const a of alertInstances) {
  byAlertname[a.alertname] = (byAlertname[a.alertname] || 0) + 1;
}

const spanMs = alertEvents.length ? Math.max(...alertEvents.map((a) => a.ts)) - Math.min(...alertEvents.map((a) => a.ts)) : 0;
const spanHours = spanMs / 1000 / 3600;

const report = {
  phase,
  generatedAt: new Date().toISOString(),
  graceMs: GRACE_MS,
  windowMins: WINDOW_MINS,
  totals: {
    realFaultWindows: realWindows.length,
    noiseFaultWindows: noiseWindows.length,
    alertInstances: alertInstances.length,
    rawNotifications: alertEvents.filter((a) => a.status === 'firing').length,
    truePositives,
    falsePositives,
    falsePositivesOnNoise,
    falsePositivesUnexplained,
    falsePositiveRate: alertInstances.length ? +(falsePositives / alertInstances.length).toFixed(3) : null,
    faultsDetected: detectedWindows.length,
    faultsMissed: missedWindows.length,
    detectionRate: realWindows.length ? +(detectedWindows.length / realWindows.length).toFixed(3) : null,
    alertsPerHour: spanHours > 0 ? +(alertInstances.length / spanHours).toFixed(2) : null,
  },
  bySeverity,
  byAlertname,
  missedFaults: missedWindows.map((w) => ({ fault: w.fault, start: new Date(w.start).toISOString(), durationMs: w.end - w.start })),
};

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, `report-${phase}.json`), JSON.stringify(report, null, 2));

console.log(`\n=== Signal report: phase "${phase}" ===`);
console.log(`Window: ${WINDOW_MINS ? WINDOW_MINS + ' min' : 'all data'}, grace: ${GRACE_MS}ms`);
console.log(`Real fault windows      : ${report.totals.realFaultWindows}  (+ ${report.totals.noiseFaultWindows} sub-SLO "blip" windows, which must NOT be alerted on)`);
console.log(`Alert instances fired  : ${report.totals.alertInstances}  (raw notifications: ${report.totals.rawNotifications})`);
console.log(`True positives         : ${report.totals.truePositives}`);
console.log(`False positives        : ${report.totals.falsePositives}  (on a blip: ${report.totals.falsePositivesOnNoise}, unexplained: ${report.totals.falsePositivesUnexplained})`);
console.log(`False positive rate    : ${report.totals.falsePositiveRate}`);
console.log(`Faults detected        : ${report.totals.faultsDetected} / ${report.totals.realFaultWindows} (rate ${report.totals.detectionRate})`);
console.log(`Alerts / hour          : ${report.totals.alertsPerHour}`);
console.log(`By severity            : ${JSON.stringify(bySeverity)}`);
console.log(`By alertname           : ${JSON.stringify(byAlertname)}`);
if (missedWindows.length) {
  console.log(`Missed faults:`);
  for (const w of report.missedFaults) console.log(`  - ${w.fault} at ${w.start} (${w.durationMs}ms)`);
}
console.log(`\nWrote data/report-${phase}.json`);
