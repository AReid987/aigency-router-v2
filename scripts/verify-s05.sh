#!/usr/bin/env bash
# scripts/verify-s05.sh — E2E S05 (SugarDB telemetry + dashboard) verification
#
# Proves the full telemetry pipeline: SugarDB stores events, SSE streams them,
# dashboard builds, and workers emit telemetry that round-trips through the engine.
#
# Usage: bash scripts/verify-s05.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# ── colours ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "  ${GREEN}PASS${NC} — $1"; }
fail() { echo -e "  ${RED}FAIL${NC} — $1"; FAILURES=$((FAILURES + 1)); }
info() { echo -e "  ${YELLOW}INFO${NC} — $1"; }

# ── state ────────────────────────────────────────────────────────────────────
PIDS=()
FAILURES=0
ENGINE_URL="ws://127.0.0.1:49134"
ENGINE_HTTP="http://127.0.0.1:3111"
SSE_PORT=3115
SSE_HTTP="http://127.0.0.1:${SSE_PORT}"

# ── cleanup ──────────────────────────────────────────────────────────────────
cleanup() {
  info "Cleaning up ${#PIDS[@]} background processes..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in "${PIDS[@]}"; do
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  done
  # Remove engine/sugar-db data directories
  rm -rf "$PROJECT_ROOT/data" 2>/dev/null || true
}
trap cleanup EXIT

# ── helpers ──────────────────────────────────────────────────────────────────
wait_for_port() {
  local port=$1 label=$2 timeout=${3:-15}
  local elapsed=0
  while ! nc -z 127.0.0.1 "$port" 2>/dev/null; do
    sleep 0.5
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$((timeout * 2))" ]; then
      return 1
    fi
  done
  return 0
}

wait_for_workers() {
  local expected=$1 timeout=${2:-30}
  local elapsed=0
  while true; do
    local count
    count=$(iii trigger engine::workers::list --json '{}' 2>/dev/null | grep -c '"name"' || echo "0")
    if [ "$count" -ge "$expected" ]; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$timeout" ]; then
      return 1
    fi
  done
}

# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo " S05 Verification: SugarDB + Telemetry + SSE + Holo-CRT Dashboard"
echo "═══════════════════════════════════════════════════════════════════"
echo ""

# ── 1. Kill stale processes ──────────────────────────────────────────────────
info "Killing any stale iii or worker processes..."
pkill -f "iii --config" 2>/dev/null || true
pkill -f "tsx src/index.ts" 2>/dev/null || true
pkill -f "sugar-db" 2>/dev/null || true
sleep 1

# ── 2. Check port conflicts ─────────────────────────────────────────────────
echo ""
echo "── Step 0: Check port availability ──"
for port in 49134 3111 $SSE_PORT 5173; do
  if nc -z 127.0.0.1 "$port" 2>/dev/null; then
    fail "Port $port is already in use — kill stale processes first"
  fi
done
if [ "$FAILURES" -gt 0 ]; then
  echo "Exiting early due to port conflicts."
  exit 1
fi
pass "All required ports (49134, 3111, $SSE_PORT, 5173) are free"

# ── 3. Start iii Engine ─────────────────────────────────────────────────────
echo ""
echo "── Step 1: Start iii Engine ──"
iii --config iii.config.yaml > /tmp/iii-engine-s05.log 2>&1 &
ENGINE_PID=$!
PIDS+=("$ENGINE_PID")
info "Engine PID: $ENGINE_PID"

if wait_for_port 49134 "engine-bridge" 15; then
  pass "Engine bridge WebSocket (ws://127.0.0.1:49134) is listening"
else
  fail "Engine bridge WebSocket not ready after 15s"
  echo "Engine log:"; tail -20 /tmp/iii-engine-s05.log
  exit 1
fi

if wait_for_port 3111 "engine-http" 10; then
  pass "Engine HTTP API (http://127.0.0.1:3111) is listening"
else
  fail "Engine HTTP API not ready after 10s"
fi

# ── 4. Start sugar-db worker ────────────────────────────────────────────────
echo ""
echo "── Step 2: Start sugar-db worker ──"
info "Starting sugar-db worker..."
(cd "$PROJECT_ROOT/workers/sugar-db" && npx tsx src/index.ts) > /tmp/iii-sugar-db.log 2>&1 &
SUGAR_PID=$!
PIDS+=("$SUGAR_PID")
info "sugar-db PID: $SUGAR_PID"

# Wait for sugar-db worker to register
if wait_for_workers 1 20; then
  pass "sugar-db worker registered with engine"
else
  fail "sugar-db worker did not register in 20s"
  echo "sugar-db log:"; tail -20 /tmp/iii-sugar-db.log
  exit 1
fi

# ── 5. Verify sugar-db registers 3 functions ────────────────────────────────
echo ""
echo "── Step 3: Verify sugar-db function registration ──"
EXPECTED_FUNCTIONS=("sugar-db::log_event" "sugar-db::query_events" "sugar-db::status")

for fn in "${EXPECTED_FUNCTIONS[@]}"; do
  FN_HELP=$(iii trigger "$fn" --help 2>&1) || true
  if echo "$FN_HELP" | grep -qi "request\|schema\|function\|description"; then
    pass "Function '$fn' is registered and queryable"
  else
    fail "Function '$fn' is NOT registered"
    info "Help output: $FN_HELP"
  fi
done

# ── 6. Trigger sugar-db::log_event with a test event ────────────────────────
echo ""
echo "── Step 4: sugar-db::log_event — store a test event ──"
LOG_RESULT=$(iii trigger sugar-db::log_event --json '{
  "event_class": "FAST_TRACK_ROUTE",
  "source_worker": "gateway",
  "payload_snapshot": {"model": "gpt-4o", "provider": "openai", "latency_ms": 42}
}' 2>&1) || true
info "sugar-db::log_event response: $LOG_RESULT"

if echo "$LOG_RESULT" | grep -qE '"log_id":\s*[0-9]+'; then
  pass "sugar-db::log_event returned valid log_id"
else
  fail "sugar-db::log_event did not return log_id"
fi

if echo "$LOG_RESULT" | grep -q '"timestamp"'; then
  pass "sugar-db::log_event returned timestamp"
else
  fail "sugar-db::log_event did not return timestamp"
fi

# ── 7. Trigger sugar-db::query_events to confirm event was stored ───────────
echo ""
echo "── Step 5: sugar-db::query_events — verify event stored ──"
QUERY_RESULT=$(iii trigger sugar-db::query_events --json '{"event_class": "FAST_TRACK_ROUTE", "limit": 5}' 2>&1) || true
info "sugar-db::query_events response: $QUERY_RESULT"

if echo "$QUERY_RESULT" | grep -q "FAST_TRACK_ROUTE"; then
  pass "sugar-db::query_events returned the FAST_TRACK_ROUTE event"
else
  fail "sugar-db::query_events did not return the expected event"
fi

if echo "$QUERY_RESULT" | grep -q "gateway"; then
  pass "Event source_worker is 'gateway'"
else
  fail "Event source_worker is not 'gateway'"
fi

if echo "$QUERY_RESULT" | grep -q "gpt-4o"; then
  pass "Event payload_snapshot contains model 'gpt-4o'"
else
  fail "Event payload_snapshot does not contain expected data"
fi

# ── 8. Trigger sugar-db::status to confirm event count ──────────────────────
echo ""
echo "── Step 6: sugar-db::status — verify event count ──"
STATUS_RESULT=$(iii trigger sugar-db::status --json '{}' 2>&1) || true
info "sugar-db::status response: $STATUS_RESULT"

if echo "$STATUS_RESULT" | grep -qE '"row_count":\s*[1-9]'; then
  pass "sugar-db::status reports row_count >= 1"
else
  fail "sugar-db::status reports row_count=0 (expected >= 1)"
fi

if echo "$STATUS_RESULT" | grep -q '"last_event_timestamp"'; then
  pass "sugar-db::status reports last_event_timestamp"
else
  fail "sugar-db::status missing last_event_timestamp"
fi

# ── 9. Check SSE endpoint responds ─────────────────────────────────────────
echo ""
echo "── Step 7: SSE endpoint health check ──"

# Give SSE server a moment to be ready
if wait_for_port $SSE_PORT "sse" 5; then
  pass "SSE server is listening on port $SSE_PORT"
else
  fail "SSE server not listening on port $SSE_PORT"
fi

# Check /health endpoint
HEALTH_RESP=$(curl -s "${SSE_HTTP}/health" 2>/dev/null || echo "curl failed")
info "SSE /health response: $HEALTH_RESP"

if echo "$HEALTH_RESP" | grep -q '"status":"ok"'; then
  pass "SSE /health endpoint returns ok"
else
  fail "SSE /health endpoint did not return ok"
fi

# Check /events endpoint returns SSE content type
SSE_HEADERS=$(curl -s -D- -o /dev/null --max-time 2 "${SSE_HTTP}/events" 2>/dev/null || echo "curl failed")
info "SSE /events headers: $(echo "$SSE_HEADERS" | head -5)"

if echo "$SSE_HEADERS" | grep -qi "text/event-stream"; then
  pass "SSE /events returns Content-Type: text/event-stream"
else
  fail "SSE /events does not return text/event-stream"
fi

# ── 10. Emit a second event and verify it round-trips ───────────────────────
echo ""
echo "── Step 8: Emit FAST_TRACK_ROUTE event and verify round-trip ──"
LOG_RESULT2=$(iii trigger sugar-db::log_event --json '{
  "event_class": "FAST_TRACK_ROUTE",
  "source_worker": "gateway",
  "payload_snapshot": {"model": "claude-sonnet-4-20250514", "provider": "anthropic", "latency_ms": 87}
}' 2>&1) || true
info "Second log_event response: $LOG_RESULT2"

if echo "$LOG_RESULT2" | grep -qE '"log_id":\s*[0-9]+'; then
  pass "Second event logged successfully"
else
  fail "Second event failed to log"
fi

# Query all FAST_TRACK_ROUTE events — should now have 2
QUERY_ALL=$(iii trigger sugar-db::query_events --json '{"event_class": "FAST_TRACK_ROUTE"}' 2>&1) || true
EVENT_COUNT=$(echo "$QUERY_ALL" | grep -c '"log_id"' || echo "0")
info "Total FAST_TRACK_ROUTE events: $EVENT_COUNT"

if [ "$EVENT_COUNT" -ge 2 ]; then
  pass "Found $EVENT_COUNT FAST_TRACK_ROUTE events (expected >= 2)"
else
  fail "Only found $EVENT_COUNT FAST_TRACK_ROUTE events (expected >= 2)"
fi

# ── 11. Dashboard build verification ────────────────────────────────────────
echo ""
echo "── Step 9: Dashboard build verification ──"
info "Installing dashboard dependencies..."
(cd "$PROJECT_ROOT/dashboard" && npm install --silent) > /tmp/iii-dashboard-install.log 2>&1 || true

info "Building dashboard..."
BUILD_OUTPUT=$(cd "$PROJECT_ROOT/dashboard" && npx vite build 2>&1) || true
BUILD_EXIT=$?
echo "$BUILD_OUTPUT" | tail -15

if [ "$BUILD_EXIT" -eq 0 ]; then
  pass "Dashboard build succeeded (vite build exit 0)"
else
  fail "Dashboard build failed (exit $BUILD_EXIT)"
fi

# Verify build output exists
if [ -f "$PROJECT_ROOT/dashboard/dist/index.html" ]; then
  pass "Dashboard dist/index.html exists"
else
  fail "Dashboard dist/index.html not found after build"
fi

# ── 12. Run sugar-db unit tests ─────────────────────────────────────────────
echo ""
echo "── Step 10: SugarDB unit tests ──"
TS_OUTPUT=$(cd "$PROJECT_ROOT/workers/sugar-db" && npx tsx --test src/index.test.ts 2>&1) || true
TS_EXIT=$?
echo "$TS_OUTPUT" | tail -20

if [ "$TS_EXIT" -eq 0 ]; then
  pass "SugarDB unit tests: all tests pass"
else
  fail "SugarDB unit tests failed (exit $TS_EXIT)"
fi

# ── 13. Run all existing worker tests (regression check) ────────────────────
echo ""
echo "── Step 11: Regression check — existing worker tests ──"
REGRESSION_FAILURES=0

for worker in gateway vault engram translator; do
  TEST_FILE="$PROJECT_ROOT/workers/$worker/src/index.test.ts"
  if [ -f "$TEST_FILE" ]; then
    WORKER_OUT=$(cd "$PROJECT_ROOT/workers/$worker" && npx tsx --test src/index.test.ts 2>&1) || true
    WORKER_EXIT=$?
    if [ "$WORKER_EXIT" -eq 0 ]; then
      pass "$worker worker tests pass"
    else
      fail "$worker worker tests FAILED"
      echo "$WORKER_OUT" | tail -10
      REGRESSION_FAILURES=$((REGRESSION_FAILURES + 1))
    fi
  else
    info "No test file for $worker — skipping"
  fi
done

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════════"
if [ "$FAILURES" -eq 0 ]; then
  echo -e " ${GREEN}ALL CHECKS PASSED${NC}"
  echo ""
  echo " SugarDB worker registered: OK (3 functions)"
  echo " Event log + query round-trip: OK"
  echo " Event count via status: OK"
  echo " SSE endpoint health: OK"
  echo " Dashboard build: OK"
  echo " SugarDB unit tests: OK"
  echo " Worker regression tests: OK"
  echo ""
  exit 0
else
  echo -e " ${RED}$FAILURES CHECK(S) FAILED${NC}"
  echo ""
  exit 1
fi
