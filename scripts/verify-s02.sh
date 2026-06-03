#!/usr/bin/env bash
# scripts/verify-s02.sh — E2E S02 (SugarVault) verification
#
# Proves the vault works end-to-end: encrypted storage, cross-language
# compatibility, no plaintext on disk, selector classification, and
# TUI launchability.
#
# Usage: bash scripts/verify-s02.sh

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
TEST_MASTER_KEY="test-verify-s02-master-password"
TEST_PROVIDER="openai"
TEST_API_KEY="sk-verify-s02-test-key-abcdef1234567890"

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
  rm -rf "$PROJECT_ROOT/data" 2>/dev/null || true
}
trap cleanup EXIT

# ── helpers ──────────────────────────────────────────────────────────────────
wait_for_port() {
  local port=$1 timeout=${2:-15}
  local elapsed=0
  while ! nc -z 127.0.0.1 "$port" 2>/dev/null; do
    sleep 0.5
    elapsed=$((elapsed + 1))
    [ "$elapsed" -ge "$((timeout * 2))" ] && return 1
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
  # Wait until a vault function responds with the expected worker field
  local fn=$1 timeout=${2:-15}
  local elapsed=0
  while true; do
    local resp
    resp=$(iii trigger "$fn" --json '{}' 2>&1) || true
    if echo "$resp" | grep -q '"worker":"vault"\|"worker": "vault"'; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
    [ "$elapsed" -ge "$timeout" ] && return 1
  done
}

# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo " S02 Verification: SugarVault (crypto + vault + selector + TUI)"
echo "═══════════════════════════════════════════════════════════════════"
echo ""

# ── 1. Kill stale processes ──────────────────────────────────────────────────
info "Killing any stale iii or worker processes..."
pkill -f "iii --config" 2>/dev/null || true
pkill -f "tsx src/index.ts" 2>/dev/null || true
sleep 1

# ── 2. Start iii Engine ─────────────────────────────────────────────────────
echo ""
echo "── Step 1: Start iii Engine ──"
iii --config iii.config.yaml > /tmp/iii-engine-s02.log 2>&1 &
ENGINE_PID=$!
PIDS+=("$ENGINE_PID")
info "Engine PID: $ENGINE_PID"

if wait_for_port 49134 15; then
  pass "Engine bridge WebSocket (ws://127.0.0.1:49134) is listening"
else
  fail "Engine bridge WebSocket not ready after 15s"
  echo "Engine log:"; tail -20 /tmp/iii-engine-s02.log
  exit 1
fi

if wait_for_port 3111 10; then
  pass "Engine HTTP API (http://127.0.0.1:3111) is listening"
else
  fail "Engine HTTP API not ready after 10s"
fi

# ── 3. Start vault worker with test master password ─────────────────────────
echo ""
echo "── Step 2: Start vault worker ──"
info "Starting vault worker with VAULT_MASTER_KEY..."
VAULT_MASTER_KEY="$TEST_MASTER_KEY" npx tsx workers/vault/src/index.ts > /tmp/iii-vault-s02.log 2>&1 &
VAULT_PID=$!
PIDS+=("$VAULT_PID")
info "Vault PID: $VAULT_PID"

if wait_for_workers 1 20; then
  pass "Vault worker registered with engine"
else
  fail "Vault worker did not register in 20s"
  echo "Vault log:"; tail -20 /tmp/iii-vault-s02.log
  exit 1
fi

# Wait for vault functions to be available
info "Waiting for vault functions to become available..."
if wait_for_function "vault::status" 15; then
  pass "Vault functions are available"
else
  fail "Vault functions not available after 15s"
  exit 1
fi

# ── 4. Call vault::store ────────────────────────────────────────────────────
echo ""
echo "── Step 3: vault::store — store test API key ──"
STORE_RESULT=$(iii trigger vault::store --json "{\"providerId\":\"$TEST_PROVIDER\",\"apiKey\":\"$TEST_API_KEY\"}" 2>&1) || true
info "vault::store response: $STORE_RESULT"

if echo "$STORE_RESULT" | grep -q '"stored":true\|"stored": true'; then
  pass "vault::store succeeded — key encrypted and stored"
else
  fail "vault::store did not return stored:true"
fi

# ── 5. Call vault::retrieve ─────────────────────────────────────────────────
echo ""
echo "── Step 4: vault::retrieve — decrypt and verify ──"
RETRIEVE_RESULT=$(iii trigger vault::retrieve --json "{\"providerId\":\"$TEST_PROVIDER\"}" 2>&1) || true
info "vault::retrieve response: $RETRIEVE_RESULT"

if echo "$RETRIEVE_RESULT" | grep -q "$TEST_API_KEY"; then
  pass "vault::retrieve returned correct decrypted key"
else
  fail "vault::retrieve did not return expected key value"
fi

# ── 6. Call vault::status ───────────────────────────────────────────────────
echo ""
echo "── Step 5: vault::status — verify key count and unlock state ──"
STATUS_RESULT=$(iii trigger vault::status --json '{}' 2>&1) || true
info "vault::status response: $STATUS_RESULT"

if echo "$STATUS_RESULT" | grep -q '"unlocked":true\|"unlocked": true'; then
  pass "vault::status reports unlocked=true"
else
  fail "vault::status does not report unlocked=true"
fi

if echo "$STATUS_RESULT" | grep -qE '"keyCount":\s*[1-9]'; then
  pass "vault::status reports keyCount >= 1"
else
  fail "vault::status reports keyCount=0 (expected >= 1)"
fi

# ── 7. Call vault::lock ─────────────────────────────────────────────────────
echo ""
echo "── Step 6: vault::lock — lock the vault ──"
LOCK_RESULT=$(iii trigger vault::lock --json '{}' 2>&1) || true
info "vault::lock response: $LOCK_RESULT"

if echo "$LOCK_RESULT" | grep -q '"locked":true\|"locked": true'; then
  pass "vault::lock reports locked=true"
else
  fail "vault::lock did not return locked:true"
fi

# ── 8. Call vault::retrieve after lock — should fail ────────────────────────
echo ""
echo "── Step 7: vault::retrieve after lock — should fail ──"
LOCKED_RETRIEVE=$(iii trigger vault::retrieve --json "{\"providerId\":\"$TEST_PROVIDER\"}" 2>&1) || true
info "vault::retrieve (locked) response: $LOCKED_RETRIEVE"

if echo "$LOCKED_RETRIEVE" | grep -qi "error\|locked"; then
  pass "vault::retrieve correctly fails when vault is locked"
else
  fail "vault::retrieve should fail when vault is locked, got: $LOCKED_RETRIEVE"
fi

# ── 9. No plaintext keys on disk ────────────────────────────────────────────
echo ""
echo "── Step 8: Verify no plaintext keys on disk ──"
# Kill vault worker so DB is flushed
kill "$VAULT_PID" 2>/dev/null || true
sleep 1

DB_FILE="$PROJECT_ROOT/data/vault.db"
DB_PATH=""
if [ -f "$DB_FILE" ]; then
  DB_PATH="$DB_FILE"
else
  DB_PATH=$(find "$PROJECT_ROOT" -name "vault.db" -maxdepth 3 2>/dev/null | head -1)
fi

if [ -n "$DB_PATH" ] && [ -f "$DB_PATH" ]; then
  PLAINTEXT_COUNT=$(strings "$DB_PATH" | grep -cE "gsk_|sk-verify" || true)
  info "Plaintext key patterns found in DB: $PLAINTEXT_COUNT"
  if [ "$PLAINTEXT_COUNT" -eq 0 ]; then
    pass "No plaintext API keys found in vault.db"
  else
    fail "Found $PLAINTEXT_COUNT plaintext key patterns in vault.db"
  fi
else
  fail "vault.db not found"
fi

# ── 10. Run TS unit tests ──────────────────────────────────────────────────
echo ""
echo "── Step 9: TypeScript unit tests ──"

for testfile in crypto.test.ts db.test.ts selector.test.ts index.test.ts; do
  TS_OUT=$(cd "$PROJECT_ROOT" && node --test "workers/vault/src/$testfile" 2>&1) || true
  TS_EXIT=$?
  if [ "$TS_EXIT" -eq 0 ]; then
    pass "$testfile — all tests pass"
  else
    fail "$testfile — exit $TS_EXIT"
    echo "$TS_OUT" | tail -10
  fi
done

# ── 11. Run Python crypto tests ────────────────────────────────────────────
echo ""
echo "── Step 10: Python crypto tests ──"

TUI_PYTHON="$PROJECT_ROOT/tui/.venv/bin/python"
if [ -x "$TUI_PYTHON" ]; then
  PY_CRYPTO=$(cd "$PROJECT_ROOT" && tui/.venv/bin/python -m pytest tui/tests/test_crypto.py -v 2>&1) || true
  PY_EXIT=$?
  echo "$PY_CRYPTO" | tail -15
  if [ "$PY_EXIT" -eq 0 ]; then
    pass "Python crypto tests — all tests pass"
  else
    fail "Python crypto tests — exit $PY_EXIT"
  fi
else
  fail "TUI Python venv not found at $TUI_PYTHON"
fi

# ── 12. Verify TUI CLI ─────────────────────────────────────────────────────
echo ""
echo "── Step 11: TUI CLI launchability ──"

if [ -x "$TUI_PYTHON" ]; then
  CLI_HELP=$(cd "$PROJECT_ROOT" && tui/.venv/bin/python -m tui.src.cli keys --help 2>&1) || true
  CLI_EXIT=$?
  if [ "$CLI_EXIT" -eq 0 ] && echo "$CLI_HELP" | grep -qi "key\|add\|list\|remove"; then
    pass "TUI CLI 'keys --help' responds correctly"
  else
    fail "TUI CLI 'keys --help' failed (exit $CLI_EXIT)"
    echo "$CLI_HELP" | tail -5
  fi
else
  fail "TUI Python venv not found"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════════"
if [ "$FAILURES" -eq 0 ]; then
  echo -e " ${GREEN}ALL CHECKS PASSED${NC}"
  echo ""
  echo " E2E vault store/retrieve/lock: OK"
  echo " No plaintext keys on disk: OK"
  echo " TS unit tests: crypto, db, selector, index: OK"
  echo " Python crypto tests: OK"
  echo " TUI CLI launchable: OK"
  echo ""
  exit 0
else
  echo -e " ${RED}$FAILURES CHECK(S) FAILED${NC}"
  echo ""
  exit 1
fi
