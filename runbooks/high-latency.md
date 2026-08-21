# Runbook: HighLatencyP95

## What this means
P95 request latency across `signal-api` has been sustained above threshold.
This is a **ticket-severity** alert in the tuned pipeline (see
`docs/tuning-notes.md` for why it doesn't page) — it indicates degraded
experience, not necessarily an outage.

## Triage
1. Grafana "Latency p50 / p95 / p99" panel — is only p95/p99 elevated (tail latency, likely a subset of requests/routes hitting something slow) or is p50 elevated too (systemic)?
2. Check "Ground-truth active fault" row — `latency_spike` explains it directly in this lab. In production, cross-reference deploys, dependency latency dashboards, and the queue depth panel (saturation often shows up as latency before it shows up as errors).
3. Check per-route breakdown: `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[2m])) by (le, route))`.

## Resolution
- **In this lab environment**: self-clearing within ~90s.
- **In a production analog**: tail latency regressions are usually either (a) a slow dependency on the critical path of specific requests, or (b) queueing/saturation upstream of this service. Check `HighQueueDepth`/`HighCPU` — if either was firing around the same time, this is almost certainly the same root cause (the tuned Alertmanager config inhibits this alert when `HighQueueDepth`/`HighCPU` is already firing for exactly this reason — see `docker/alertmanager/definitions/alertmanager-tuned.yml`).

## Escalation
Escalate to page-severity if p95 exceeds 2x the alert threshold, or if it's sustained past 10 minutes — at that point it's no longer "degraded," it's effectively an outage for tail-latency-sensitive callers.

## Related
- Alert defined in: `docker/prometheus/rules/definitions/tuned-alerts.yml`
- Postmortem example: `postmortems/incident-1-latency-spike.md`
