#!/usr/bin/env bash
# Switches the live Prometheus rule set + Alertmanager routing config
# between phases and hot-reloads both (no container restart needed).
#
# Usage: scripts/switch-phase.sh none|naive|tuned
set -euo pipefail

PHASE="${1:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$PHASE" in
  none)
    rm -f "$ROOT/docker/prometheus/rules/active/"*.yml
    ;;
  naive|tuned)
    rm -f "$ROOT/docker/prometheus/rules/active/"*.yml
    cp "$ROOT/docker/prometheus/rules/definitions/${PHASE}-alerts.yml" "$ROOT/docker/prometheus/rules/active/"
    cp "$ROOT/docker/alertmanager/definitions/alertmanager-${PHASE}.yml" "$ROOT/docker/alertmanager/alertmanager.yml"
    ;;
  *)
    echo "Usage: $0 none|naive|tuned" >&2
    exit 1
    ;;
esac

echo "Reloading Prometheus rules..."
curl -fsS -X POST http://localhost:9090/-/reload && echo "  ok"

if [ "$PHASE" != "none" ]; then
  echo "Reloading Alertmanager config..."
  curl -fsS -X POST http://localhost:9093/-/reload && echo "  ok"
fi

echo "Phase set to: $PHASE"
