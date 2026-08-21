# Tuning notes: naive → tuned

This documents the specific changes made between the Phase 2 ("naive")
and Phase 3 ("tuned") alerting configs, and the reasoning behind each one.
The actual before/after numbers this produced are in the top-level
README; this file is about *why*, not *what happened*.

## 1. Debounce short conditions (`for:`)

Naive rules use `for: 0s` — the instant a PromQL expression crosses
threshold on a single evaluation, it fires. Prometheus evaluates rules
every 5s in this stack, so a single bad scrape is enough.

The fault injector includes a `blip` fault type specifically to exploit
this: a 3-8 second wobble in latency/error rate, well within the range
of normal production noise (a GC pause, a slow disk flush, a single
retried connection). A pipeline that pages on every blip is a pipeline
that pages constantly on nothing.

Tuned rules require the condition to hold for 30-45s (`for: 30s` /
`for: 45s`). A `blip` cannot satisfy that; a real fault (which this
pipeline's other fault types run for 20-90s) usually can.

## 2. Recalibrate thresholds against observed noise, not vibes

The naive thresholds (error rate > 5%, p95 > 200ms, queue depth > 50,
CPU > 70%) were chosen the way a lot of real threshold alerts get chosen:
they sound reasonable in the abstract. They were never checked against
what this specific service's normal traffic actually looks like.

The tuned thresholds were set by looking at the Phase 1 baseline
dashboard (no faults injected, pure ambient noise) and the `blip` fault's
actual magnitude, then picking thresholds that sit clearly above both:

| Signal | Normal baseline | `blip` fault | Real fault | Naive threshold | Tuned threshold |
|---|---|---|---|---|---|
| error rate | ~0% | 5-15% | 35-70% (`error_burst`) | > 5% | > 25% |
| p95 latency | ~15-60ms | +150-300ms | +400-1200ms (`latency_spike`) | > 200ms | > 350ms |
| queue depth | 2-8 | unaffected | 80-200 (`saturation`) | > 50 | > 40* |
| CPU % | 8-20 | unaffected | 85-97 (`saturation`) | > 70 | > 60* |

\* Queue depth and CPU thresholds didn't need to move much — the naive
values were already reasonably separated from baseline. The `for:`
duration is what was actually broken for these two; they're included
here to show that "tuning" isn't always "raise the number."

## 3. Severity tiers: not everything is a page

Naive config: every alert is `severity: page`. Tuned config splits:

- `page`: `HighErrorRate`, `HighQueueDepth`, `HighCPU` — conditions that
  are either already customer-facing (errors) or reliably become
  customer-facing within minutes if left alone (saturation).
- `ticket`: `HighLatencyP95` — degraded experience, not (yet) an outage.
  Worth fixing during business hours, not worth waking someone up.

## 4. Alertmanager: group, don't spray

Naive Alertmanager config: `group_by: []`, `group_wait: 0s`,
`group_interval: 1s`. Every firing alert is its own notification, sent
essentially immediately, and re-sent every 30s (`repeat_interval: 30s`)
for as long as it's firing. A single `saturation` fault (which sets both
queue depth and CPU above threshold simultaneously) produces two
separate, immediately-repeating notification streams for one root cause.

Tuned config groups by `alertname` + `route`, gives `page`-severity
alerts a short `group_wait`/`repeat_interval` (still urgent, just not
spammy) and `ticket`-severity alerts long ones (they don't need repeated
paging while someone's already looking at the ticket).

## 5. Inhibition: one root cause, one notification

Added two inhibition rules: `HighQueueDepth` and `HighCPU` each suppress
`HighLatencyP95`. Saturation causes latency as a direct, well-understood
downstream effect — see `service/faults.js`, where the `saturation` fault
only touches `queueDepth`/`cpuPercent` directly, but elevated queueing
naturally shows up as elevated request latency too. Without inhibition,
one `saturation` event pages/tickets *and* separately alerts on the
latency it caused. With it, the responder gets one notification pointing
at the actual root cause, and `runbooks/high-latency.md` explicitly
tells them to check for exactly this correlation if they land there
anyway.

## What this deliberately does not do

This pipeline stays threshold/rate-based rather than reaching for
anomaly-detection ML, on purpose — see the README's "what I'd do
differently at scale" section for where that tradeoff would flip.
