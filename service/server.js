'use strict';

const express = require('express');
const client = require('prom-client');
const { FaultInjector } = require('./faults');

const PORT = process.env.PORT || 8080;
const SERVICE_NAME = process.env.SERVICE_NAME || 'signal-api';

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'signal_' });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const queueDepthGauge = new client.Gauge({
  name: 'signal_queue_depth',
  help: 'Simulated pending work queue depth',
  registers: [register],
});

const cpuPercentGauge = new client.Gauge({
  name: 'signal_cpu_percent',
  help: 'Simulated CPU utilization percent',
  registers: [register],
});

const activeFaultGauge = new client.Gauge({
  name: 'signal_active_fault',
  help: 'Whether a ground-truth fault is currently injected (1/0), by fault name',
  labelNames: ['fault'],
  registers: [register],
});

const injector = new FaultInjector();

setInterval(() => {
  queueDepthGauge.set(injector.state.queueDepth);
  cpuPercentGauge.set(injector.state.cpuPercent);
  register.resetMetrics && null; // no-op, keep registry warm
  const faults = ['latency_spike', 'error_burst', 'saturation', 'blip'];
  for (const f of faults) {
    activeFaultGauge.set({ fault: f }, injector.active && injector.active.name === f ? 1 : 0);
  }
}, 2000).unref();

const app = express();

function jsonLog(obj) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), service: SERVICE_NAME, ...obj }) + '\n');
}

const ROUTES = ['/api/checkout', '/api/inventory', '/api/users/:id', '/api/search'];

app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route ? req.baseUrl + req.route.path : req.path;
    httpRequestDuration.observe({ method: req.method, route, status_code: res.statusCode }, durationSec);
    httpRequestsTotal.inc({ method: req.method, route, status_code: res.statusCode });
    jsonLog({
      level: res.statusCode >= 500 ? 'error' : 'info',
      msg: 'http_request',
      method: req.method,
      route,
      status_code: res.statusCode,
      duration_ms: Math.round(durationSec * 1000),
      active_fault: injector.active ? injector.active.name : null,
    });
  });
  next();
});

function simulateWork(req, res, next) {
  const { extraLatencyMs, errorRate } = injector.state;
  const baseLatency = 15 + Math.random() * 45;
  const totalDelay = baseLatency + extraLatencyMs;

  setTimeout(() => {
    if (Math.random() < errorRate) {
      return res.status(503).json({ error: 'service_unavailable' });
    }
    res.status(200).json({ ok: true, route: req.path });
  }, totalDelay);
}

app.get('/api/checkout', simulateWork);
app.get('/api/inventory', simulateWork);
app.get('/api/users/:id', simulateWork);
app.get('/api/search', simulateWork);

app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

app.get('/fault-status', (req, res) => res.status(200).json(injector.status()));

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () => {
  jsonLog({ level: 'info', msg: 'service_started', port: PORT });
});
