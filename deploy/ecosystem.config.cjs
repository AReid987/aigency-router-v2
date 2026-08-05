/**
 * ecosystem.config.cjs — pm2 process definitions for Aigency Router cluster
 *
 * One file for all nodes. Filter by role using pm2 --only:
 *   pm2 start ecosystem.config.cjs --only iii-engine
 *   pm2 start ecosystem.config.cjs --only gateway
 *
 * Service naming convention:
 *   <service>          = Mac 1 (control plane) service
 *   <service>-a        = Mac 2 (worker A) service
 *   <service>-b        = Mac 3 (worker B) service
 *
 * SugarDB is a Docker container, NOT a pm2 process. Start it separately:
 *   docker run -d --name sugardb --restart unless-stopped \
 *     -p 8081:8081 -v sugar-db-data:/data sugardb/sugardb:latest
 *
 * Use deploy/cluster-up.sh to start the correct services per node automatically.
 */

const repoPath = process.env.REPO_PATH || `${process.env.HOME}/CODE/00_PROJECTS/00_APPS/AIGENCY/aigency-router-v2`
const mac1Ip = process.env.MAC1_IP || '100.x.x.x'
const adminToken = process.env.GATEWAY_ADMIN_TOKEN || ''
const vaultKey = process.env.VAULT_MASTER_KEY || ''

module.exports = {
  apps: [
    // ═══════════════════════════════════════════════════════════════════════
    // Mac 1 — Control Plane
    // ═══════════════════════════════════════════════════════════════════════
    {
      name: 'iii-engine',
      cwd: repoPath,
      script: 'node',
      args: '--import tsx iii-engine/src/engine.ts',
      env: { NODE_ENV: 'production' },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: `${repoPath}/logs/iii-engine-error.log`,
      out_file: `${repoPath}/logs/iii-engine-out.log`,
      merge_logs: true,
    },
    {
      name: 'vault',
      cwd: repoPath,
      script: 'node',
      args: '--import tsx workers/vault/src/index.ts',
      env: {
        NODE_ENV: 'production',
        III_URL: 'ws://127.0.0.1:49134',
        VAULT_DB_PATH: `${repoPath}/data/vault.db`,
        VAULT_MASTER_KEY: vaultKey,
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '256M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: `${repoPath}/logs/vault-error.log`,
      out_file: `${repoPath}/logs/vault-out.log`,
      merge_logs: true,
    },
    {
      name: 'gateway',
      cwd: repoPath,
      script: 'node',
      args: '--import tsx workers/gateway/src/index.ts',
      env: {
        NODE_ENV: 'production',
        III_URL: 'ws://127.0.0.1:49134',
        GATEWAY_SUGAR_DB_URL: 'http://127.0.0.1:8081',
        GATEWAY_ADMIN_TOKEN: adminToken,
        GATEWAY_HEALTH_PORT: '9090',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: `${repoPath}/logs/gateway-error.log`,
      out_file: `${repoPath}/logs/gateway-out.log`,
      merge_logs: true,
    },

    // ═══════════════════════════════════════════════════════════════════════
    // Mac 2 — Worker Node A
    // ═══════════════════════════════════════════════════════════════════════
    {
      name: 'gateway-a',
      cwd: repoPath,
      script: 'node',
      args: '--import tsx workers/gateway/src/index.ts',
      env: {
        NODE_ENV: 'production',
        III_URL: `ws://${mac1Ip}:49134`,
        GATEWAY_SUGAR_DB_URL: `http://${mac1Ip}:8081`,
        GATEWAY_ADMIN_TOKEN: adminToken,
        GATEWAY_HEALTH_PORT: '9090',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: `${repoPath}/logs/gateway-a-error.log`,
      out_file: `${repoPath}/logs/gateway-a-out.log`,
      merge_logs: true,
    },
    {
      name: 'selector-a',
      cwd: repoPath,
      script: 'node',
      args: '--import tsx workers/selector/src/index.ts',
      env: {
        NODE_ENV: 'production',
        III_URL: `ws://${mac1Ip}:49134`,
        SELECTOR_OFFLOAD_ENABLED: 'true',
        TAILSCALE_PEERS_URL: process.env.TAILSCALE_PEERS_URL || '',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '1G',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: `${repoPath}/logs/selector-a-error.log`,
      out_file: `${repoPath}/logs/selector-a-out.log`,
      merge_logs: true,
    },
    {
      name: 'translator',
      cwd: repoPath,
      script: 'node',
      args: '--import tsx workers/translator/src/index.ts',
      env: {
        NODE_ENV: 'production',
        III_URL: `ws://${mac1Ip}:49134`,
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '256M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: `${repoPath}/logs/translator-error.log`,
      out_file: `${repoPath}/logs/translator-out.log`,
      merge_logs: true,
    },

    // ═══════════════════════════════════════════════════════════════════════
    // Mac 3 — Worker Node B
    // ═══════════════════════════════════════════════════════════════════════
    {
      name: 'gateway-b',
      cwd: repoPath,
      script: 'node',
      args: '--import tsx workers/gateway/src/index.ts',
      env: {
        NODE_ENV: 'production',
        III_URL: `ws://${mac1Ip}:49134`,
        GATEWAY_SUGAR_DB_URL: `http://${mac1Ip}:8081`,
        GATEWAY_ADMIN_TOKEN: adminToken,
        GATEWAY_HEALTH_PORT: '9091',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: `${repoPath}/logs/gateway-b-error.log`,
      out_file: `${repoPath}/logs/gateway-b-out.log`,
      merge_logs: true,
    },
    {
      name: 'selector-b',
      cwd: repoPath,
      script: 'node',
      args: '--import tsx workers/selector/src/index.ts',
      env: {
        NODE_ENV: 'production',
        III_URL: `ws://${mac1Ip}:49134`,
        SELECTOR_OFFLOAD_ENABLED: 'true',
        TAILSCALE_PEERS_URL: process.env.TAILSCALE_PEERS_URL || '',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '1G',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: `${repoPath}/logs/selector-b-error.log`,
      out_file: `${repoPath}/logs/selector-b-out.log`,
      merge_logs: true,
    },
    {
      name: 'provider-clients',
      cwd: repoPath,
      script: 'node',
      args: '--import tsx workers/provider-clients/src/index.ts',
      env: {
        NODE_ENV: 'production',
        III_URL: `ws://${mac1Ip}:49134`,
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '256M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: `${repoPath}/logs/provider-clients-error.log`,
      out_file: `${repoPath}/logs/provider-clients-out.log`,
      merge_logs: true,
    },
  ],
}
