'use strict';

/**
 * Fault injection engine.
 *
 * This is the ground truth for the whole project: every fault window it
 * opens/closes is timestamped and written to /data/fault_log.jsonl. The
 * analysis script later cross-references alert timestamps against this
 * file to compute real true/false positive rates — nobody has to eyeball
 * a dashboard and guess whether an alert "seemed" justified.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const FAULT_LOG = path.join(DATA_DIR, 'fault_log.jsonl');

const FAULT_TYPES = [
  {
    name: 'latency_spike',
    weight: 3,
    minMs: 30_000,
    maxMs: 90_000,
    apply: (state) => { state.extraLatencyMs = 400 + Math.random() * 800; },
    clear: (state) => { state.extraLatencyMs = 0; },
  },
  {
    name: 'error_burst',
    weight: 3,
    minMs: 20_000,
    maxMs: 60_000,
    apply: (state) => { state.errorRate = 0.35 + Math.random() * 0.35; },
    clear: (state) => { state.errorRate = 0; },
  },
  {
    name: 'saturation',
    weight: 2,
    minMs: 30_000,
    maxMs: 60_000,
    apply: (state) => { state.queueDepth = 80 + Math.random() * 120; state.cpuPercent = 85 + Math.random() * 12; },
    clear: (state) => { state.queueDepth = baselineQueueDepth(); state.cpuPercent = baselineCpu(); },
  },
  {
    name: 'blip',
    // Sub-SLO, single-scrape-interval blip. Real traffic has these constantly;
    // a well-tuned pipeline must NOT alert on them. A naive one will.
    weight: 6,
    minMs: 3_000,
    maxMs: 8_000,
    apply: (state) => { state.extraLatencyMs = 150 + Math.random() * 150; state.errorRate = 0.05 + Math.random() * 0.1; },
    clear: (state) => { state.extraLatencyMs = 0; state.errorRate = 0; },
  },
];

function baselineQueueDepth() { return 2 + Math.random() * 6; }
function baselineCpu() { return 8 + Math.random() * 12; }

function weightedPick(types) {
  const total = types.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  for (const t of types) {
    if ((r -= t.weight) <= 0) return t;
  }
  return types[types.length - 1];
}

class FaultInjector {
  constructor() {
    this.state = {
      extraLatencyMs: 0,
      errorRate: 0,
      queueDepth: baselineQueueDepth(),
      cpuPercent: baselineCpu(),
    };
    this.active = null; // { name, startedAt, endsAt }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this._scheduleNext();
    // Slow ambient drift so dashboards aren't perfectly flat between faults.
    setInterval(() => {
      if (!this.active) {
        this.state.queueDepth = baselineQueueDepth();
        this.state.cpuPercent = baselineCpu();
      }
    }, 5000).unref();
  }

  _log(event) {
    fs.appendFileSync(FAULT_LOG, JSON.stringify({ ts: Date.now(), iso: new Date().toISOString(), ...event }) + '\n');
  }

  _scheduleNext() {
    const gapMs = 20_000 + Math.random() * 40_000; // quiet period between faults
    setTimeout(() => this._startFault(), gapMs).unref();
  }

  _startFault() {
    const type = weightedPick(FAULT_TYPES);
    const durationMs = type.minMs + Math.random() * (type.maxMs - type.minMs);
    const startedAt = Date.now();
    const endsAt = startedAt + durationMs;
    this.active = { name: type.name, startedAt, endsAt };
    type.apply(this.state);
    this._log({ event: 'fault_start', fault: type.name, duration_ms: Math.round(durationMs) });

    setTimeout(() => {
      type.clear(this.state);
      this._log({ event: 'fault_end', fault: type.name });
      this.active = null;
      this._scheduleNext();
    }, durationMs).unref();
  }

  status() {
    return {
      active: this.active ? this.active.name : null,
      since: this.active ? new Date(this.active.startedAt).toISOString() : null,
      state: this.state,
    };
  }
}

module.exports = { FaultInjector };
