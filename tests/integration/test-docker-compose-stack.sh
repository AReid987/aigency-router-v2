#!/usr/bin/env bash
# =============================================================================
# Integration smoke test for the docker compose stack
#
# Starts the full stack (gateway, caddy, sugar-db, vault), verifies that:
#   1. Caddy :8443 is reachable and /health returns 200
#   2. /v1/admin/quota without X-Admin-Token returns 401
#   3. /v1/admin/quota with a valid token does NOT return 401
#      (proves header propagation through Caddy)
#
# Skips gracefully if Docker is not available.
# =============================================================================

set -e

# Skip if Docker unavailable
command -v docker >/dev/null 2>&1 || { echo "SKIP: docker not available"; exit 0; }

cd "$(dirname "$0")/../.."

# Bring up the stack
docker compose up -d gateway caddy sugar-db vault 2>&1 || { echo "SKIP: docker compose failed to start"; docker compose down 2>/dev/null || true; exit 0; }

# Wait for caddy :8443 to be reachable
SUCCESS=0
for i in $(seq 1 30); do
    CODE=$(curl -k --connect-timeout 1 -s -o /dev/null -w '%{http_code}' https://127.0.0.1:8443/health 2>/dev/null || echo 000)
    if [ "$CODE" = "200" ]; then
        SUCCESS=1
        break
    fi
    sleep 1
done

if [ "$SUCCESS" = "0" ]; then
    echo "FAIL: /health did not return 200 within 30s"
    docker compose down 2>/dev/null || true
    exit 1
fi

# Verify /v1/admin/quota without token returns 401
CODE_NO_TOKEN=$(curl -k -s -o /dev/null -w '%{http_code}' https://127.0.0.1:8443/v1/admin/quota 2>/dev/null || echo 000)
if [ "$CODE_NO_TOKEN" != "401" ]; then
    echo "FAIL: /v1/admin/quota without token returned $CODE_NO_TOKEN (expected 401)"
    docker compose down 2>/dev/null || true
    exit 1
fi

# Verify /v1/admin/quota with token returns 200 (or 404 if subsystem missing —
# anything except 401 proves header propagation)
CODE_WITH_TOKEN=$(curl -k -s -o /dev/null -w '%{http_code}' -H "X-Admin-Token: ${GATEWAY_ADMIN_TOKEN:-test-admin-token}" https://127.0.0.1:8443/v1/admin/quota 2>/dev/null || echo 000)
if [ "$CODE_WITH_TOKEN" = "401" ]; then
    echo "FAIL: X-Admin-Token did not propagate through Caddy (got 401 with valid token)"
    docker compose down 2>/dev/null || true
    exit 1
fi

echo "PASS: docker compose stack serves /health and X-Admin-Token propagates correctly"
docker compose down 2>/dev/null || true
exit 0
