# Postmortem: saturation event, 03:38:34–03:41:23

**Severity:** page (ran against the Phase 3 tuned pipeline)
**Duration:** ~2m49s wall-clock (36.3s underlying fault + decay tail)
**Detected by:** `HighQueueDepth` (see [`docker/prometheus/rules/definitions/tuned-alerts.yml`](../docker/prometheus/rules/definitions/tuned-alerts.yml))
**Runbook followed:** [`runbooks/saturation.md`](../runbooks/saturation.md)

## Timeline (from `data/fault_log.jsonl` and `data/alerts_log.phase3.jsonl`)

| Time (UTC) | Event |
|---|---|
| 03:38:34.791 | Fault injector starts `saturation` (queue depth 80-200, CPU 85-97%, 36.3s) |
| 03:39:10.988 | `saturation` fault ends |
| 03:39:23.800 | **`HighQueueDepth` fires** — `severity: page`, `startsAt: 03:39:11.433` |
| 03:41:23.802 | **`HighQueueDepth` resolves** — `endsAt: 03:39:21.433` |

## What happened

Queue depth and CPU both crossed their thresholds together (they always
do in this fault model — see `service/faults.js`), sustained for the
required 30s, and paged. No separate `HighLatencyP95` alert fired during
or shortly after this window, despite saturation reliably driving up
tail latency as a downstream effect.

That's not a detection gap — it's the inhibition rule in
[`docker/alertmanager/definitions/alertmanager-tuned.yml`](../docker/alertmanager/definitions/alertmanager-tuned.yml)
working as designed:

```yaml
inhibit_rules:
  - source_match:
      alertname: HighQueueDepth
    target_match:
      alertname: HighLatencyP95
    equal: []
```

Per `runbooks/saturation.md`, the responder's expectation going in is
exactly this: one page for the root cause, and if latency is elevated
too, it's expected to be suppressed rather than paging separately.

## Triage (per runbook)

1. Queue depth / CPU panel: both elevated together, consistent with the runbook's "genuine saturation" pattern rather than a CPU-only or queue-only anomaly.
2. Request rate check: traffic was flat through this window (loadgen's steady ~8rps ± the sine-wave wander, no spike) — ruling out "this is just real load," which per the runbook would point at a stuck/slow downstream call instead. In this lab that's moot (the fault is synthetic), but it's the check a real responder would do next.

## Resolution

Self-resolved once the fault cleared; queue depth and CPU returned to
baseline (2-8 / 8-20%) within the `for: 30s` window's worth of
evaluations, and the alert cleared ~10s after the metrics actually
recovered (evaluation-interval lag, not a real delay).

## Follow-up

None needed. This incident is the cleanest confirmation in this
project's data that the inhibition rule added in Phase 3 does what
`docs/tuning-notes.md` §5 claims: one root cause, one notification,
even though the underlying condition (elevated queue depth *and*
elevated latency) technically satisfied two separate alert rules.
