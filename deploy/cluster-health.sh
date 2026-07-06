#!/usr/bin/env bash
# =============================================================================
# cluster-health.sh — Check health of all Aigency Router cluster nodes
#
# Usage:
#   ./deploy/cluster-health.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/cluster-config.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

printf "\n${CYAN}=== Aigency Router Cluster Health ===${NC}\n\n"

printf "%-20s %-10s %-15s %-10s %-10s\n" "NODE" "SSH" "PM2" "HEALTH" "DETAILS"
printf "%-20s %-10s %-15s %-10s %-10s\n" "----" "---" "---" "------" "-------"

check_node() {
  local name="$1" ip="$2" services="$3" health_port="$4"
  local ssh_status="✗" pm2_status="—" health_status="—" details=""

  if ssh_cmd "${ip}" "echo ok" >/dev/null 2>&1; then
    ssh_status="✓"

    # PM2 check — count running vs total
    local pm2_out
    pm2_out=$(ssh_cmd "${ip}" "pm2 jlist 2>/dev/null" || echo "[]")
    local running_count total_count
    running_count=$(echo "${pm2_out}" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
        try { const a=JSON.parse(d); console.log(a.filter(p=>p.pm2_env?.status==='running').length) }
        catch(e) { console.log(0) }
      })
    " 2>/dev/null || echo "0")
    total_count=$(echo "${pm2_out}" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
        try { const a=JSON.parse(d); console.log(a.length) }
        catch(e) { console.log(0) }
      })
    " 2>/dev/null || echo "0")

    if [[ "${running_count}" -gt 0 ]]; then
      pm2_status="${running_count}/${total_count} running"
    else
      pm2_status="0/${total_count}"
      details="no processes"
    fi

    # Health endpoint — check gateway's health port
    local health_resp
    health_resp=$(ssh_cmd "${ip}" "curl -sf --max-time 3 http://127.0.0.1:${health_port}/health 2>/dev/null" || echo "")
    if [[ -n "${health_resp}" ]]; then
      health_val=$(echo "${health_resp}" | node -e "
        let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
          try { const o=JSON.parse(d); console.log(o.status||'?') }
          catch(e) { console.log('err') }
        })
      " 2>/dev/null || echo "?")
      health_status="${health_val}"
    else
      health_status="—"
    fi
  else
    details="unreachable"
  fi

  local ssh_color="${RED}" pm2_color="${RED}" health_color="${RED}"
  [[ "${ssh_status}" == "✓" ]] && ssh_color="${GREEN}"
  [[ "${pm2_status}" == *running* ]] && pm2_color="${GREEN}"
  [[ "${health_status}" == "ok" ]] && health_color="${GREEN}"
  [[ "${health_status}" == "—" ]] && health_color="${YELLOW}"

  printf "%-20s ${ssh_color}%-10s${NC} ${pm2_color}%-15s${NC} ${health_color}%-10s${NC} %-10s\n" \
    "${name}" "${ssh_status}" "${pm2_status}" "${health_status}" "${details}"
}

# Gateway health ports: 9090 for Mac1/Mac2, 9091 for Mac3 (gateway-b)
check_node "Mac 1 (Control Plane)" "${MAC1_IP}" "${MAC1_SERVICES}" "9090"
check_node "Mac 2 (Worker A)" "${MAC2_IP}" "${MAC2_SERVICES}" "9090"
check_node "Mac 3 (Worker B)" "${MAC3_IP}" "${MAC3_SERVICES}" "9091"

echo ""

# ── iii-engine check (TCP port probe — no npm deps needed) ─────────────────
printf "${CYAN}--- iii-engine (Mac 1) ---${NC}\n"
if ssh_cmd "${MAC1_IP}" "bash -c '</dev/tcp/127.0.0.1/49134' 2>/dev/null" 2>/dev/null; then
  printf "  WebSocket hub (port 49134): ${GREEN}listening${NC}\n"
else
  # Fallback: try nc if /dev/tcp not available in non-interactive bash
  if ssh_cmd "${MAC1_IP}" "nc -z -w3 127.0.0.1 49134 2>/dev/null" 2>/dev/null; then
    printf "  WebSocket hub (port 49134): ${GREEN}listening${NC}\n"
  else
    printf "  iii-engine: ${YELLOW}not responding on ws://127.0.0.1:49134${NC}\n"
  fi
fi

echo ""
