# Runbook: HighQueueDepth / HighCPU (saturation)

## What this means
The service is doing more work than it can keep up with — pending queue
depth and/or simulated CPU utilization are both elevated. Left unchecked,
saturation turns into latency, then errors, as request handling falls
behind.

## Triage
1. Grafana "Queue depth / CPU %" panel — confirm both are elevated together (this pipeline's `saturation` fault always moves them together; in production they can decouple, which itself is diagnostic — CPU-bound vs. queue-bound are different problems).
2. Check request rate (`sum(rate(http_requests_total[1m])) by (route)`) — is this a genuine traffic spike, or is throughput flat while queue depth climbs (points at a stuck/slow downstream call instead of load)?
3. Check whether `HighLatencyP95` is also firing. In the tuned pipeline it's inhibited while this alert is active (same root cause, one notification) — see `docker/alertmanager/definitions/alertmanager-tuned.yml`.

## Resolution
- **In this lab environment**: self-clearing within ~60s.
- **In a production analog**: for a genuine traffic spike, this is a scale-out signal (add capacity / enable autoscaling). For flat-throughput-but-climbing-queue, this points at a downstream dependency that's slow or hung — check its health directly rather than throwing capacity at this service.

## Escalation
Page-severity by design (both faults that cause this are customer-impacting once sustained). If queue depth keeps climbing after 5 minutes rather than plateauing, this is a capacity incident, not a blip — escalate immediately rather than waiting out the runbook.

## Related
- Alert defined in: `docker/prometheus/rules/definitions/tuned-alerts.yml`
- Postmortem example: `postmortems/incident-3-saturation.md`
