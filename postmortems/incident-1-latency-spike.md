# Postmortem: latency regression flurry, 03:46–03:52

**Severity:** ticket (ran against the Phase 3 tuned pipeline)
**Duration:** ~5 minutes wall-clock (three underlying faults, one alert episode)
**Detected by:** `HighLatencyP95` (see [`docker/prometheus/rules/definitions/tuned-alerts.yml`](../docker/prometheus/rules/definitions/tuned-alerts.yml))
**Runbook followed:** [`runbooks/high-latency.md`](../runbooks/high-latency.md)

## Timeline (from `data/fault_log.jsonl` and `data/alerts_log.phase3.jsonl`)

| Time (UTC) | Event |
|---|---|
| 03:46:02.860 | Fault injector starts `latency_spike` #1 (+400-1200ms, 68.5s) |
| 03:47:11.345 | `latency_spike` #1 ends |
| 03:47:18.602 | **`HighLatencyP95` fires** — `severity: ticket`, `startsAt: 03:47:01.433` |
| 03:48:26.049 | `latency_spike` #2 starts (34.6s) |
| 03:49:00.598 | `latency_spike` #2 ends |
| 03:49:41.449 | `latency_spike` #3 starts (32.1s) |
| 03:50:13.568 | `latency_spike` #3 ends |
| 03:52:18.500 | **`HighLatencyP95` resolves** — same `startsAt: 03:47:01.433`, `endsAt: 03:52:11.433` |

## What happened

Three separate `latency_spike` faults landed back-to-back with gaps
(75s, 41s) too short for the `histogram_quantile(..., rate(...[2m]))`
window used by this rule to fully decay between them. The practical
effect: **one continuous alert episode covered all three faults.**
Alertmanager sent exactly one notification when it started and one when
it fully resolved five minutes later — not three separate pages.

Under the Phase 2 naive config (no grouping, `repeat_interval: 30s`,
`severity: page` on everything), this same sequence would have produced
somewhere around 8-10 separate page notifications across ~6 minutes,
all severity `page`. This is the single clearest example in this
project's data of what "grouping" (`docs/tuning-notes.md` §4) actually
buys you: it's not just about noisy alerts, it's about a genuinely
correlated sequence of real problems reading as one incident instead of
a flood.

## Triage (per runbook)

1. Grafana p95/p99 panel showed the pattern immediately: three distinct step-ups over ~4 minutes, not one continuous plateau.
2. Ground-truth fault panel confirmed all three as `latency_spike` — same fault type, so almost certainly the same underlying cause repeating (or, read the way an on-call engineer without ground truth would: "something is intermittently regressing latency every ~1-2 minutes, look for a flapping dependency or a bad instance cycling in and out of a load balancer").
3. `HighQueueDepth`/`HighCPU` were not firing concurrently, ruling out saturation as the cause (consistent with `latency_spike` being an isolated-dependency-style fault in this model, not a capacity one).

## Resolution

Self-resolved — all three faults were transient by design. Ticket
severity meant no page was sent; the alert sat as a ticket for the
5-minute duration and closed on its own.

## Follow-up

None needed for this lab run. In a production analog: a *recurring*
latency regression (three times in 4 minutes) from the same fault
signature would justify opening a real ticket even after auto-resolution,
specifically to find the common cause across the three occurrences
rather than treating each as independent.
