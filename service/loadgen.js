'use strict';

/**
 * Continuous synthetic traffic generator. Hits the app at a roughly
 * constant rate with a mild day/night sine wave so dashboards have some
 * texture, independent of the fault injector running inside the app.
 */

const TARGET = process.env.TARGET_URL || 'http://app:8080';
const ROUTES = ['/api/checkout', '/api/inventory', '/api/users/42', '/api/search'];
const BASE_RPS = Number(process.env.BASE_RPS || 8);

function pickRoute() {
  return ROUTES[Math.floor(Math.random() * ROUTES.length)];
}

async function fireOne() {
  const route = pickRoute();
  try {
    await fetch(TARGET + route, { signal: AbortSignal.timeout(5000) });
  } catch (_) {
    // loadgen doesn't care about individual failures; the app's own
    // metrics/logs are the source of truth.
  }
}

function currentRps() {
  const wave = Math.sin(Date.now() / 1000 / 90) * 0.3 + 1; // +/-30% wander
  return Math.max(1, BASE_RPS * wave);
}

async function tick() {
  const rps = currentRps();
  const n = Math.max(1, Math.round(rps));
  for (let i = 0; i < n; i++) fireOne();
  setTimeout(tick, 1000);
}

console.log(JSON.stringify({ msg: 'loadgen_started', target: TARGET, base_rps: BASE_RPS }));
tick();
