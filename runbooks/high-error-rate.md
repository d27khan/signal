# Runbook: HighErrorRate

## What this means
5xx responses have crossed the alert threshold for the `signal-api`
service. Customers making requests during this window are seeing failures.

## Triage
1. Check the **Signal — Service Overview** Grafana dashboard, "Error rate" panel — is it still climbing, flat, or already recovering?
2. Check the "Ground-truth active fault" row on the same dashboard (this is a lab environment, so this is your fastest signal). If `error_burst` is active, this is expected — skip to Resolution.
3. Check service logs (Loki panel, filter `level="error"`) for the actual error payloads driving the 5xx rate.
4. Check which route(s) are affected: `sum(rate(http_requests_total{status_code=~"5..",}[1m])) by (route)` in Prometheus — one bad route points at a specific dependency, all routes points at something systemic (DB, upstream, resource exhaustion).

## Resolution
- **In this lab environment**: `error_burst` faults are self-clearing (20-60s). If the alert resolves within that window with no manual action, that's expected behavior — the pipeline is meant to page on it because it's a sustained, real degradation, not something to silence.
- **In a production analog**: this pattern (elevated 5xx across all routes, self-resolving) usually maps to a downstream dependency (DB connection pool exhaustion, upstream timeout) recovering on its own via retries/circuit breakers. Confirm the dependency's own health dashboard, not just this service's.

## Escalation
If error rate does not recover within 5 minutes of the alert firing, escalate — this exceeds every fault duration this pipeline is designed to tolerate on its own.

## Related
- Alert defined in: `docker/prometheus/rules/definitions/tuned-alerts.yml` (and the deliberately noisy `naive-alerts.yml`, see `docs/tuning-notes.md`)
- Postmortem example: `postmortems/incident-2-error-burst.md`
