# Postmortems

Three simulated incidents run against the **tuned** (Phase 3) pipeline,
each following its runbook end to end. Real timestamps, real Grafana
queries, real alert payloads from this project's own `data/` logs — not
hypothetical.

- [incident-1-latency-spike.md](incident-1-latency-spike.md)
- [incident-2-error-burst.md](incident-2-error-burst.md)
- [incident-3-saturation.md](incident-3-saturation.md)

Each follows the same shape: detection → triage (per the linked runbook)
→ resolution → what the tuning from `docs/tuning-notes.md` did or didn't
help with.
