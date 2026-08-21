# Postmortem: missed detection — error_burst, 03:58:04–03:58:57

**Severity:** none — this is a postmortem about an alert that *should
have fired and didn't*, found by this project's own measurement
pipeline (`service/analyze.js`), not a postmortem about a page that was
handled.
**Runbook that would have applied:** [`runbooks/high-error-rate.md`](../runbooks/high-error-rate.md)

This is the more useful postmortem of the three. Phases 2 and 3 both
"worked" in the sense that alerts fired and got resolved. This is the
one place the tuned pipeline's own before/after data (see the README's
results table) shows a real, quantified cost, and it's worth
understanding exactly why rather than treating "detection rate went
down" as a number to explain away.

## What happened

`data/fault_log.jsonl` records a 52.7-second `error_burst` fault
(injected error rate 35-70%) starting at `2026-08-05T03:58:04.522Z` and
ending at `03:58:57.243Z`. The tuned `HighErrorRate` rule
(`sum(rate(http_requests_total{status_code=~"5.."}[1m])) / sum(rate(...[1m])) > 0.25`,
`for: 30s`) never fired for it. No alert, no page, nothing in
`data/alerts_log.phase3.jsonl` overlapping this window.

## Root cause: rate-window dilution eats into the debounce budget

Querying Prometheus directly for the exact computed ratio during this
window (`histogram_quantile` isn't involved here, just the raw ratio)
shows why:

| Time (UTC) | Computed error ratio |
|---|---|
| 03:58:10 | 0.005 |
| 03:58:20 | 0.089 |
| 03:58:30 | 0.200 |
| 03:58:40 | 0.233 |
| **03:58:50** | **0.270** ← crosses the 0.25 threshold |
| 03:59:05 | 0.366 (peak) |
| 03:59:20 | 0.276 |
| **03:59:25** | **0.247** ← drops back below 0.25 |

The `rate(...[1m])` window means the computed ratio doesn't jump to the
fault's true 35-70% instantly — it ramps up over roughly the first 45
seconds as fault-period requests displace pre-fault requests in the
trailing window, then ramps back down over a similar tail *after* the
fault has already ended. The condition was only continuously true for
approximately 35 seconds (03:58:50 → 03:59:25) against a `for: 30s`
requirement — technically enough on paper, but Prometheus's actual
5-second-aligned evaluation schedule didn't land enough consecutive
"true" evaluations within that narrower real window to satisfy it.

**The fault itself (52.7s) comfortably exceeds the 30s debounce. The
*measurement* of it, through a 1-minute rate window, does not.** This is
a direct, measured instance of the exact tradeoff called out in
`docs/tuning-notes.md` and the README: debouncing to kill blip-driven
false positives (which worked — see Phase 3's 0% false positive rate)
narrows the margin for real faults whose *diluted* signal duration lands
near the debounce window, even when their true duration doesn't.

A shorter `error_burst` in the same run (20.3s, well under any
reasonable debounce) was also missed — that one's a cleaner case: the
fault was simply shorter than the `for: 30s` requirement could ever
satisfy, dilution aside.

## What I'd actually change

Documented in the README results table and `docs/tuning-notes.md`, not
re-litigated here in full, but concretely: `sum(rate(...[1m]))` is doing
double duty as both "smooth out scrape noise" and "the window whose
trailing edge determines how fast the alert can react." Decoupling those
— e.g., a shorter rate window (better reaction time) paired with the
`for:` clause doing the actual debouncing (rather than both mechanisms
fighting for the same 30-45 second budget) — would very likely have
caught this one without reopening the door to blip-driven false
positives, since blips are 3-8s and would still fail even a well-tuned
shorter `for:` requirement. This wasn't corrected in this project's data
because the point of Phase 3 was to measure the tuning that was actually
shipped, not to iterate until every miss disappeared — a real on-call
team would take this postmortem's finding as the input to a Phase 3.1.
