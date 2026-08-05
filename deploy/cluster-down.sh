#!/usr/bin/env bash
# =============================================================================
# cluster-down.sh — Stop the Aigency Router cluster
#
# Usage:
#   ./deploy/cluster-down.sh           # stop all nodes
#   ./deploy/cluster-down.sh mac1      # stop only Mac 1
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/cluster-config.sh"

log_info "Aigency Router Cluster — Stopping..."

targets=("${@}")
if [[ ${#targets[@]} -eq 0 ]]; then
  targets=(mac1 mac2 mac3)
fi

for target in "${targets[@]}"; do
  case "${target}" in
    mac1) ip="${MAC1_IP}" services="${MAC1_SERVICES}" ;;
    mac2) ip="${MAC2_IP}" services="${MAC2_SERVICES}" ;;
    mac3) ip="${MAC3_IP}" services="${MAC3_SERVICES}" ;;
    *) log_warn "Unknown node: ${target}"; continue ;;
  esac

  log_info "Stopping ${target} (${ip})..."

  ssh_cmd "${ip}" bash -s <<REMOTE || { log_error "Failed to stop ${target}"; continue; }
    cd "${REPO_PATH}"
    IFS=',' read -ra SVC <<< '${services}'
    for svc in "\${SVC[@]}"; do
      pm2 stop "\${svc}" 2>/dev/null && echo "stopped \${svc}" || echo "\${svc} not running"
    done
    pm2 save
REMOTE

  log_ok "${target} stopped"
done

log_ok "Cluster stopped"
