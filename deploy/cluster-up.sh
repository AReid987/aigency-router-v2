#!/usr/bin/env bash
# =============================================================================
# cluster-up.sh — Start the Aigency Router cluster via SSH + pm2
#
# Usage:
#   ./deploy/cluster-up.sh          # start all nodes
#   ./deploy/cluster-up.sh mac1     # start only Mac 1 (control plane)
#   ./deploy/cluster-up.sh mac2 mac3  # start only worker nodes
#
# Prerequisites:
#   1. SSH keys set up to all 3 MacBooks (ssh-copy-id)
#   2. pm2 installed on all 3 machines (npm i -g pm2)
#   3. Repo cloned to identical path on all machines
#   4. cluster-config.sh edited with your Tailscale IPs
#   5. Secrets exported: GATEWAY_ADMIN_TOKEN, VAULT_MASTER_KEY
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/cluster-config.sh"

# ── Pre-flight checks ──────────────────────────────────────────────────────

log_info "Aigency Router Cluster — Starting..."

if [[ -z "${GATEWAY_ADMIN_TOKEN}" ]]; then
  log_error "GATEWAY_ADMIN_TOKEN not set. Export it first."
  exit 1
fi

if [[ -z "${VAULT_MASTER_KEY}" ]]; then
  log_error "VAULT_MASTER_KEY not set. Export it first."
  exit 1
fi

# ── Connectivity checks ────────────────────────────────────────────────────

check_node() {
  local name="$1" ip="$2"
  if ! check_connectivity "${ip}" "${name}"; then
    log_error "Cannot reach ${name}. Is it online and SSH enabled?"
    return 1
  fi
}

# ── Start SugarDB on Mac 1 (Docker container, not pm2) ─────────────────────

start_sugardb() {
  local ip="$1"
  log_info "Ensuring SugarDB is running on Mac 1..."

  ssh_cmd "${ip}" bash -s <<'REMOTE'
    # Check if container exists
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^sugardb$'; then
      echo "[mac1] SugarDB already running"
    elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^sugardb$'; then
      docker start sugardb
      echo "[mac1] SugarDB restarted"
    else
      echo "[mac1] SugarDB container not found — creating..."
      docker run -d --name sugardb --restart unless-stopped \
        -p 8081:8081 -v sugar-db-data:/data sugardb/sugardb:latest
      echo "[mac1] SugarDB started"
    fi
REMOTE
  log_ok "SugarDB ready"
}

# ── Deploy function ─────────────────────────────────────────────────────────

deploy_node() {
  local name="$1" ip="$2" services="$3" iii_url="$4"

  log_info "Deploying ${name} (${ip}) — services: ${services}"

  ssh_cmd "${ip}" bash -s <<REMOTE
    mkdir -p "${REPO_PATH}/logs" "${REPO_PATH}/data" "${REPO_PATH}/backups"
    cd "${REPO_PATH}"

    # Export secrets and config so ecosystem.config.cjs can read them
    export GATEWAY_ADMIN_TOKEN='${GATEWAY_ADMIN_TOKEN}'
    export VAULT_MASTER_KEY='${VAULT_MASTER_KEY}'
    export III_URL='${iii_url}'
    export REPO_PATH='${REPO_PATH}'
    export MAC1_IP='${MAC1_IP}'
    export TAILSCALE_PEERS_URL='${TAILSCALE_PEERS_URL:-}'

    # Verify pm2 is installed
    if ! command -v pm2 &>/dev/null; then
      echo "[${name}] ERROR: pm2 not found. Run: npm i -g pm2"
      exit 1
    fi

    # Start each service (skip if already running)
    IFS=',' read -ra SVC <<< '${services}'
    for svc in "\${SVC[@]}"; do
      if pm2 describe "\${svc}" >/dev/null 2>&1; then
        pm2 restart "\${svc}" --update-env
        echo "[${name}] restarted \${svc}"
      else
        pm2 start "${REPO_PATH}/deploy/ecosystem.config.cjs" --only "\${svc}" --update-env
        echo "[${name}] started \${svc}"
      fi
    done

    pm2 save
REMOTE
  log_ok "${name} deployed"
}

# ── Determine which nodes to start ─────────────────────────────────────────

targets=("${@}")
if [[ ${#targets[@]} -eq 0 ]]; then
  targets=(mac1 mac2 mac3)
fi

# ── Check connectivity first ───────────────────────────────────────────────

for target in "${targets[@]}"; do
  case "${target}" in
    mac1) check_node "Mac 1 (Control Plane)" "${MAC1_IP}" ;;
    mac2) check_node "Mac 2 (Worker A)" "${MAC2_IP}" ;;
    mac3) check_node "Mac 3 (Worker B)" "${MAC3_IP}" ;;
    *) log_warn "Unknown node: ${target}" ;;
  esac
done

# ── Start control plane first, then workers in parallel ────────────────────

# If mac1 is in the targets, start it first (SugarDB + iii-engine must be up)
for target in "${targets[@]}"; do
  if [[ "${target}" == "mac1" ]]; then
    start_sugardb "${MAC1_IP}"
    deploy_node "mac1" "${MAC1_IP}" "${MAC1_SERVICES}" "ws://127.0.0.1:49134"
    log_info "Waiting 5s for iii-engine to accept connections..."
    sleep 5
    break
  fi
done

# Then deploy workers in parallel
pids=()
for target in "${targets[@]}"; do
  case "${target}" in
    mac2)
      deploy_node "mac2" "${MAC2_IP}" "${MAC2_SERVICES}" "ws://${MAC1_IP}:49134" &
      pids+=($!)
      ;;
    mac3)
      deploy_node "mac3" "${MAC3_IP}" "${MAC3_SERVICES}" "ws://${MAC1_IP}:49134" &
      pids+=($!)
      ;;
  esac
done

# Wait for all deployments
failed=0
for pid in "${pids[@]}"; do
  if ! wait "${pid}"; then
    failed=$((failed + 1))
  fi
done

if [[ ${failed} -gt 0 ]]; then
  log_error "${failed} node(s) failed to deploy"
  exit 1
fi

log_ok "All nodes deployed successfully"
log_info "Run ./deploy/cluster-health.sh to verify"
