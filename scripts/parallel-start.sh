#!/usr/bin/env bash
# scripts/parallel-start.sh — Launch all workers simultaneously and verify clean registration
#
# Starts the iii engine, then launches ALL workers in parallel (not sequentially),
# waits for registration, and verifies each worker is healthy.
#
# Usage: bash scripts/parallel-start.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# ── colours ───────────────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "  ${GREEN}PASS${NC} — $1"; }
fail() { echo -e "  ${RED}FAIL${NC} — $1"; FAILURES=$((FAILURES + 1)); }
info() { echo -e "  ${YELLOW}INFO${NC} — $1"; }

PIDS=()
FAILURES=0
ENGINE_URL="ws://127.0.0.1:49134"

# ── cleanup ─────────────────────────────────────────────────────────
cleanup() {
  info "Cleaning up ${#PIDS[@]} processes..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in "${PIDS[@]}"; do
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  done
  rm -rf "$PROJECT_ROOT/data" 2>/dev/null || true
}
trap cleanup EXIT

# ── helpers ────────────────────────────────────────────────────────
wait_for_port() {
  local port=$1 label=$2 timeout=${3:-15}
  local elapsed=0
  while ! nc -z 127.0.0.1 "$port" 2>/dev/null; do
    sleep 0.5
    elapsed=$((elapsed + 1))
    [ "$elapsed" -ge $((timeout * 2)) ] && return 1
  done
  return 0
}

wait_for_workers() {
  local expected=$1 timeout=${2:-30}
  local elapsed=0
  while true; do
    local count
    count=$(iii trigger engine::workers::list --json '{}' 2>/dev/null | grep -c '"name"' || echo "0")
    [ "$count" -ge "$expected" ] && return 0
    sleep 1
    elapsed=$((elapsed + 1))
    [ "$elapsed" -ge "$timeout" ] && return 1
  done
}

wait_for_function() {
  local fn=$1 worker=$2 timeout=${3:-20}
  local elapsed=0
  while true; do
    local resp
    resp=$(iii trigger "$fn" --json '{}' 2>&1) || true
    if echo "$resp" | grep -q "\"worker\":\"$worker\"\|\"worker\": \"$worker\""; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
    [ "$elapsed" -ge "$timeout" ] && return 1
  done
}

# ═══════════════════════════════════════════════════════════════════
echo ""
echo "════════════════════════════════════════════════════════════════"
echo " Parallel Start: All Workers Simultaneously"
echo "════════════════════════════════════════════════════════════════"
echo ""

# ── 1. Kill stale processes ────────────────────────────────────
info "Killing stale processes..."
pkill -f "iii --config" 2>/dev/null || true
pkill -f "tsx src/index.ts" 2>/dev/null || true
pkill -f "workers/brain" 2>/dev/null || true
sleep 1

# ── 2. Start engine ────────────────────────────────────────────
echo ""
echo "── Step 1: Start engine ──"
iii --config iii.config.yaml > /tmp/iii-parallel-engine.log 2>&1 &
ENGINE_PID=$!
PIDS+=("$ENGINE_PID")

if wait_for_port 49134 "engine-bridge" 15; then
  pass "Engine bridge ws://127.0.0.1:49134 is listening"
else
  fail "Engine bridge not ready after 15s"
  tail -10 /tmp/iii-parallel-engine.log
  exit 1
fi

if wait_for_port 3111 "engine-http" 10; then
  pass "Engine HTTP API http://127.0.0.1:3111 is listening"
else
  fail "Engine HTTP API not ready after 10s"
fi

# ── 3. Start ALL workers in parallel ───────────────────────────
echo ""
echo "── Step 2: Start all workers in parallel ──"

# TypeScript workers — all launched simultaneously
for w in gateway vault engram translator; do
  (cd "$PROJECT_ROOT/workers/$w" && npx tsx src/index.ts > "/tmp/iii-parallel-$w.log" 2>&1) &
  info "Launched $w (PID $!)"
  PIDS+=($!)
done

# Python brain worker — also in parallel
(cd "$PROJECT_ROOT/workers/brain" && .venv/bin/python3 -m src.main > /tmp/iii-parallel-brain.log 2>&1) &
info "Launched brain (PID $!)"
PIDS+=($!)

echo ""
info "All ${#PIDS[@]} processes launched. Waiting for registration..."

# ── 4. Wait for all workers to register ─────────────────────────
echo ""
echo "── Step 3: Wait for all 5 workers to register ──"

if wait_for_workers 5 30; then
  pass "All 5 workers registered within 30s"
else
  fail "Not all workers registered within 30s"
fi

# ── 5. Verify each worker function is callable ──────────────────
echo ""
echo "── Step 4: Verify worker functions ──"

declare -A WORKER_FNS=(
  ["gateway::status"]="gateway"
  ["vault::status"]="vault"
  ["engram::status"]="engram"
  ["translator::status"]="translator"
  ["brain::status"]="brain"
)

for fn in "${!WORKER_FNS[@]}"; do
  worker="${WORKER_FNS[$fn]}"
  if wait_for_function "$fn" "$worker" 15; then
    pass "$fn responds"
  else
    fail "$fn not responding"
  fi
done

# ── 6. Final registry snapshot ──────────────────────────────────
echo ""
echo "── Step 5: Worker registry snapshot ──"
iii trigger engine::workers::list --json '{}' 2>/dev/null \
  | grep '"name"' \
  | sed 's/.*"name": "\([^"]*\)".*/  - \1/' || true

# ── Summary ────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════"
if [ "$FAILURES" -eq 0 ]; then
  echo -e " ${GREEN}ALL WORKERS STARTED IN PARALLEL SUCCESSFULLY${NC}"
  echo ""
  echo "  Processes launched: ${#PIDS[@]}"
  echo "  All 5 workers registered: YES"
  echo "  All status functions callable: YES"
  echo ""
  exit 0
else
  echo -e " ${RED}$FAILURES CHECK(S) FAILED${NC}"
  echo ""
  for w in gateway vault engram translator brain; do
    echo "--- $w log ---"
    tail -5 "/tmp/iii-parallel-$w.log" 2>/dev/null || true
  done
  exit 1
fi
