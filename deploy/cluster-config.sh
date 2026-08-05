#!/usr/bin/env bash
# =============================================================================
# cluster-config.sh — Shared configuration for Aigency cluster management
#
# Source this file from cluster-up.sh, cluster-down.sh, cluster-health.sh
#
# EDIT THIS FILE: Replace the Tailscale IPs with your actual IPs.
# To find yours: run `tailscale status` or `tailscale ip` on each machine.
# =============================================================================

# ── Tailscale IPs (replace with your actual IPs) ────────────────────────────
export MAC1_IP="100.x.x.x"   # Control plane: iii-engine, vault, gateway, sugar-db
export MAC2_IP="100.x.x.x"   # Worker A: gateway, selector, translator
export MAC3_IP="100.x.x.x"   # Worker B: gateway, selector, provider-clients

# ── SSH config ──────────────────────────────────────────────────────────────
export SSH_USER="${SSH_USER:-antonio}"
export SSH_OPTS="-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"
export SSH_PORT="${SSH_PORT:-22}"

# ── Repo path on each machine (must be identical, must be absolute) ─────────
# IMPORTANT: Do NOT use ~ — it won't expand inside double-quoted variable
# assignments. Use $HOME or the full absolute path.
export REPO_PATH="${REPO_PATH:-/Users/${SSH_USER}/CODE/00_PROJECTS/00_APPS/AIGENCY/aigency-router-v2}"

# ── Node / pm2 paths ───────────────────────────────────────────────────────
export NODE_VERSION="22"

# ── Service lists per node (matched to ecosystem.config.cjs names) ──────────
# sugar-db is a Docker container, not a pm2 process — cluster-up.sh handles it
export MAC1_SERVICES="iii-engine,vault,gateway"
export MAC2_SERVICES="gateway-a,selector-a,translator"
export MAC3_SERVICES="gateway-b,selector-b,provider-clients"

# ── Secrets (set these or export before running cluster-up.sh) ──────────────
export GATEWAY_ADMIN_TOKEN="${GATEWAY_ADMIN_TOKEN:-}"
export VAULT_MASTER_KEY="${VAULT_MASTER_KEY:-}"

# ── Tailscale peer discovery URL (for OffloadRouter) ────────────────────────
export TAILSCALE_PEERS_URL="${TAILSCALE_PEERS_URL:-}"

# ── Utility functions ───────────────────────────────────────────────────────

ssh_cmd() {
  local ip="$1"
  shift
  ssh ${SSH_OPTS} -p "${SSH_PORT}" "${SSH_USER}@${ip}" "$@"
}

mosh_to() {
  # mosh for interactive sessions (handles roaming, network drops, laptop sleep)
  local ip="$1"
  shift
  mosh "${SSH_USER}@${ip}" --ssh="ssh -p ${SSH_PORT}" "$@"
}

log_info()  { printf "\033[36m[cluster]\033[0m %s\n" "$*"; }
log_ok()    { printf "\033[32m[  ok  ]\033[0m %s\n" "$*"; }
log_warn()  { printf "\033[33m[ warn ]\033[0m %s\n" "$*"; }
log_error() { printf "\033[31m[error ]\033[0m %s\n" "$*"; }

check_connectivity() {
  local ip="$1"
  local name="$2"
  # Use SSH instead of ping — Tailscale sometimes blocks ICMP
  if ! ssh ${SSH_OPTS} -o ConnectTimeout=5 -p "${SSH_PORT}" \
       "${SSH_USER}@${ip}" "echo ok" >/dev/null 2>&1; then
    log_error "${name} (${ip}) is unreachable via SSH"
    return 1
  fi
  log_ok "${name} (${ip}) reachable"
  return 0
}
