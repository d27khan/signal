'use strict';

/**
 * Stands in for a paging system. Alertmanager sends webhook notifications
 * here; every notification is appended to /data/alerts_log.jsonl so the
 * analysis script can compute real alert-volume and false-positive
 * numbers instead of eyeballing a dashboard.
 *
 * Alertmanager batches firing alerts into groups per notification, so we
 * flatten each group back out into one log line per (alert, status) pair.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const PHASE = process.env.PHASE || 'unknown';
const OUT_FILE = path.join(DATA_DIR, `alerts_log.${PHASE}.jsonl`);

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '2mb' }));

app.post('/webhook', (req, res) => {
  const body = req.body || {};
  const receivedAt = Date.now();
  for (const alert of body.alerts || []) {
    const line = {
      ts: receivedAt,
      iso: new Date(receivedAt).toISOString(),
      phase: PHASE,
      status: alert.status,
      alertname: alert.labels && alert.labels.alertname,
      severity: alert.labels && alert.labels.severity,
      route: alert.labels && alert.labels.route,
      startsAt: alert.startsAt,
      endsAt: alert.endsAt,
      groupKey: body.groupKey,
    };
    fs.appendFileSync(OUT_FILE, JSON.stringify(line) + '\n');
    console.log(JSON.stringify({ msg: 'alert_notification', ...line }));
  }
  res.status(200).json({ received: (body.alerts || []).length });
});

app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

const PORT = process.env.PORT || 9099;
app.listen(PORT, () => console.log(JSON.stringify({ msg: 'webhook_receiver_started', port: PORT, phase: PHASE, out: OUT_FILE })));
