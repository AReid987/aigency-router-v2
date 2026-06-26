# Operations Guide — Aigency Gateway

This document covers everything an ops engineer needs to deploy, configure, monitor, back up, and troubleshoot the Aigency Gateway stack.

---

## 1. Prerequisites

Before deploying, ensure your environment meets these minimum requirements:

- **Docker** version 24+ (with Compose v2 plugin)
- **Caddy** version 2+ (only needed for bare-metal deployment without Docker)
- **pnpm** version 8+ (only needed for bare-metal deployment)
- **Node.js** version 22 LTS (only needed for bare-metal deployment)
- **Disk space** — at least 1 GB for the `sugar-db-data` volume (SQLite usage database grows with request volume)

Required ports that must be available on the host:

| Port(s) | Service | Purpose |
|---------|---------|---------|
| 8080 | gateway | Internal HTTP API (not exposed to host in Docker) |
| 8081 | sugar-db | Key-value/document store for telemetry and usage |
| 8082 | vault | Admin token and API key store |
| 8443, 443 | caddy | HTTPS reverse proxy (8443 for local dev, 443 for production) |
| 9090 | gateway | Health server for K8s/Docker liveness and readiness probes |

---

## 2. Configuration

The gateway is configured entirely through environment variables. All GATEWAY\_\* variables are read at startup. The table below documents every supported variable.

### Rate Limiting

| Name | Type | Default | Required For | Security Note |
|------|------|---------|-------------|---------------|
| GATEWAY_RATE_LIMITING | boolean | `"false"` | Opt-in rate limiting on `/v1/chat/completions` | Enable to protect against client abuse. When off, no limit is enforced. |
| GATEWAY_RATE_LIMIT_TOKENS | integer | `"100"` | Token bucket capacity when rate limiting is enabled | Higher values allow more burst traffic. Monitor `x-ratelimit-remaining` header. |
| GATEWAY_RATE_LIMIT_WINDOW_MS | integer | `"60000"` | Refill window (ms) for the token bucket | Shorter windows increase burst tolerance. Default is 60 seconds. |

### Admin Authentication

| Name | Type | Default | Required For | Security Note |
|------|------|---------|-------------|---------------|
| GATEWAY_ADMIN_AUTH | boolean | `"false"` | Opt-in authentication on `/v1/admin/*` endpoints | REQUIRED in production. Enable to protect admin routes. |
| GATEWAY_ADMIN_TOKEN | string | *none* | Admin API access — **REQUIRED** when `GATEWAY_ADMIN_AUTH=true` | **SECRET.** Generate via `openssl rand -hex 32`. Never commit to version control. |

### Quota Monitoring

| Name | Type | Default | Required For | Security Note |
|------|------|---------|-------------|---------------|
| GATEWAY_QUOTA_MONITORING | boolean | `"false"` | Enable `/v1/admin/quota` endpoint with per-provider usage status | Exposes quota status via the admin API. Combine with `GATEWAY_ADMIN_AUTH` to restrict access. |

### Zero-Cost Enforcement (Free-Tier Circuit Breaker)

| Name | Type | Default | Required For | Security Note |
|------|------|---------|-------------|---------------|
| GATEWAY_ZERO_COST_ENFORCEMENT | boolean | `"false"` | Enforce free-tier-only routing via circuit breaker | When enabled, requests to quota-exhausted providers return 503. |
| GATEWAY_ZERO_COST_DB_PATH | path | `"./data/usage.db"` | SQLite database path for the usage tracker | Ensure the parent directory exists and is writable. |
| GATEWAY_ZERO_COST_GROQ_LIMIT | integer | `"1000"` | Free-tier quota limit for the groq provider | Total tokens allowed before the circuit breaker opens. |
| GATEWAY_ZERO_COST_CEREBRAS_LIMIT | integer | `"500"` | Free-tier quota limit for the cerebras provider | Total tokens allowed before the circuit breaker opens. |
| GATEWAY_ZERO_COST_TOGETHER_LIMIT | integer | `"800"` | Free-tier quota limit for the together provider | Total tokens allowed before the circuit breaker opens. |

### Pipeline

| Name | Type | Default | Required For | Security Note |
|------|------|---------|-------------|---------------|
| GATEWAY_USE_ENGRAM_PIPELINE | boolean | `"false"` | Route complex requests through the engram DAG pipeline | When enabled, requests classified as COMPLEX by the brain worker are routed through engram DAG orchestration instead of the standard provider path. |

### Service URLs

| Name | Type | Default | Required For | Security Note |
|------|------|---------|-------------|---------------|
| GATEWAY_VAULT_URL | URL | `"http://127.0.0.1:8082"` | Vault worker endpoint for API key retrieval | Must point to a running vault service. |
| GATEWAY_SUGAR_DB_URL | URL | `"http://127.0.0.1:8081"` | Sugar-DB endpoint for telemetry event storage | Must point to a running sugar-db service. |
| III_URL | URL | `"ws://127.0.0.1:49134"` | iii Engine WebSocket URL for worker registration | Must point to a running iii Engine. Used by all workers, not just the gateway. |

### Health and Dashboard

| Name | Type | Default | Required For | Security Note |
|------|------|---------|-------------|---------------|
| GATEWAY_HEALTH_PORT | integer | `"9090"` | Port for the standalone health HTTP server | Separate from the main gateway port. Used by Docker/K8s health checks. |
| GATEWAY_COST_REPORTING | boolean | `"false"` | Enable cost reporting endpoints and dashboards | When enabled, tracks per-request cost data. |
| GATEWAY_DASHBOARD | boolean | `"false"` | Enable the web dashboard | Serves dashboard HTML at the dashboard endpoint. |
| GATEWAY_DASHBOARD_STREAM | boolean | `"false"` | Enable streaming dashboard updates | When enabled, the dashboard receives live event push. |

### Cost Tracking

| Name | Type | Default | Required For | Security Note |
|------|------|---------|-------------|---------------|
| COST_RATE_GROQ_USD | float | *none* | Per-token cost rate for groq provider (USD) | Required for accurate cost reporting. |
| COST_RATE_OPENAI_USD | float | *none* | Per-token cost rate for OpenAI provider (USD) | Required for accurate cost reporting. |

### Provider Tuning

| Name | Type | Default | Required For | Security Note |
|------|------|---------|-------------|---------------|
| PROVIDER_TIER_OVERRIDE | string | *none* | Override the tier classification for all providers | Applied at startup. Overrides provider response behavior. |

### Logging

| Name | Type | Default | Required For | Security Note |
|------|------|---------|-------------|---------------|
| LOG_LEVEL | string | `"info"` | Pino log level: trace \| debug \| info \| warn \| error \| fatal | Lower levels produce more output. Use `debug` during development, `info` in production. |

---

## 3. Secret Management

### Generating the Admin Token

Generate a cryptographically random admin token:

```bash
openssl rand -hex 32
```

This produces a 64-character hex string. Set it as the `GATEWAY_ADMIN_TOKEN` environment variable.

### Token Rotation Procedure

1. Generate a new token using `openssl rand -hex 32`.
2. Deploy the new token alongside the old one by setting **both** in the environment for 24 hours (the gateway reads `GATEWAY_ADMIN_TOKEN`; update the env var via rolling restart).
3. After 24 hours, remove the old token reference and confirm all clients have migrated.
4. Update the token in your secret store.

### Storage Backends

**Kubernetes Secrets:**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: gateway-secrets
type: Opaque
stringData:
  GATEWAY_ADMIN_TOKEN: "<64-char-hex>"
```

Reference the secret in your Deployment manifest via `envFrom` or `valueFrom.secretKeyRef`.

**AWS Secrets Manager:**

Store the token as a plaintext secret, then inject it into the container via environment variables:

```bash
aws secretsmanager create-secret \
  --name aigency/gateway/admin-token \
  --secret-string "<64-char-hex>"
```

In your ECS task definition or Kubernetes pod, reference the secret using the AWS Secrets Manager integration or the `aws-secrets-store-csi-driver`.

**HashiCorp Vault:**

Use a Vault Agent sidecar to inject the token as a file or environment variable at container startup. Example Vault Agent template:

```
{{ with secret "kv/data/gateway" }}
export GATEWAY_ADMIN_TOKEN="{{ .Data.data.admin_token }}"
{{ end }}
```

---

## 4. Deployment

### Primary Path — Docker Compose

From the repository root:

```bash
docker compose up -d
```

This starts the full stack: sugar-db, vault, gateway, and Caddy reverse proxy.

Verify the deployment:

```bash
curl -k https://127.0.0.1:8443/health
```

Expected response:

```json
{"status":"ok","uptimeMs":123456,"version":"0.0.0"}
```

Check readiness (probes dependency services):

```bash
curl -k https://127.0.0.1:8443/ready
```

Expected response (all dependencies healthy):

```json
{"status":"ready","checks":{"vault":{"ok":true,"latencyMs":5},"sugarDb":{"ok":true,"latencyMs":3}}}
```

### Bare-Metal Fallback

If Docker is not available, run the gateway directly:

```bash
cd workers/gateway
pnpm install
pnpm build
node dist/index.js
```

You will need to start sugar-db and vault independently and set `GATEWAY_SUGAR_DB_URL` and `GATEWAY_VAULT_URL` accordingly. TLS termination must be handled by a separate reverse proxy.

### Reverse Proxy Alternatives

If Caddy is not desired, use nginx with this minimal configuration:

```nginx
server {
    listen 443 ssl;
    server_name gateway.example.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Admin-Token $http_x_admin_token;
        proxy_set_header X-Api-Key $http_x_api_key;
    }
}
```

---

## 5. Monitoring

### Telemetry Event Reference

The gateway emits telemetry events to sugar-db. Each event carries a class that identifies the type of occurrence. Below is the reference table with trigger context and suggested alert thresholds.

| Event Class | When It Triggers | Suggested Alert |
|-------------|------------------|-----------------|
| HEALTH_CHECK_OK | GET `/health` returns 200 | No alert — normal operation |
| HEALTH_CHECK_FAIL | GET `/ready` returns 503 (dependency unhealthy) | Page on-call if duration exceeds 30 seconds |
| RATE_LIMIT_EXCEEDED | Client request denied by rate limiter (>10/min sustained) | Investigate if >100/min — possible abuse or misconfigured client |
| AUTH_REJECTED | Admin request denied due to missing or invalid `X-Admin-Token` header | Investigate if >5/min — potential credential stuffing |
| QUOTA_ALERT | Free-tier usage crosses 80% of the configured limit for any provider | Prepare to rotate or top up quota |
| QUOTA_EXHAUSTED | Free-tier limit reached — all requests to that provider return 503 | Page on-call |
| QUOTA_CHECK | Periodic quota status poll | No alert — informational |
| COST_ENFORCED | Zero-cost circuit breaker triggered for a provider | Investigate usage patterns |
| FAST_TRACK_ROUTE | Request routed via simple (non-engram) path | No alert — informational |
| PROVIDER_FAILOVER | Provider returned error and failover engine switched to the next provider | Alert if failover count per provider exceeds 3 per minute |

| DRIFT_HEALED | Provider response was repaired by the heal integration | No alert — informational (track drift rate for provider quality assessment) |
| TIER_REFUSED | Request refused based on tier classification | Alert if >10/min — investigate provider tier config |

### Pino JSON Log Structure

All gateway logs are written as newline-delimited JSON via [pino](https://getpino.io/). Every log line contains these base fields:

| Field | Type | Description |
|-------|------|-------------|
| `time` | ISO-8601 string | Timestamp of the log event |
| `level` | string | Log level: trace, debug, info, warn, error, fatal |
| `pid` | integer | Process ID |
| `service` | string | Always `"aigency-gateway"` |
| `version` | string | Package version from `package.json` |
| `msg` | string | Human-readable message |

Per-call fields are appended as a second JSON argument to the log method. Example log line:

```json
{"level":"info","time":"2026-06-26T12:00:00.000Z","pid":1,"service":"aigency-gateway","version":"0.0.0","msg":"route_success","model":"gpt-4","provider":"openai","stream":false}
```

### Alert Wiring

**Slack via Incoming Webhook:**

```bash
curl -X POST https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXX \
  -H "Content-Type: application/json" \
  -d '{"text": "🚨 *Aigency Gateway Alert*\nEvent: QUOTA_EXHAUSTED\nProvider: groq\nTime: 2026-06-26T12:00:00Z"}'
```

**PagerDuty via Events API v2:**

```bash
curl -X POST https://events.pagerduty.com/v2/enqueue \
  -H "Content-Type: application/json" \
  -d '{
    "routing_key": "your-pagerduty-routing-key",
    "event_action": "trigger",
    "payload": {
      "summary": "Aigency Gateway: QUOTA_EXHAUSTED for groq",
      "severity": "critical",
      "source": "aigency-gateway",
      "custom_details": {
        "provider": "groq",
        "threshold": "1000"
      }
    }
  }'
```

---

## 6. Backup and Restore

The only stateful component in the stack is the sugar-db SQLite database, which stores telemetry events and usage tracking data.

### Backup

Run this command to create a backup of the usage database:

```bash
docker compose exec sugar-db sqlite3 /data/usage.db ".backup /backups/usage-$(date +%F).db"
```

For automated backups, add a cron job:

```bash
0 2 * * * cd /opt/aigency && docker compose exec sugar-db sqlite3 /data/usage.db ".backup /backups/usage-$(date +\%F).db"
```

### Restore

To restore the usage database from a backup:

```bash
docker compose stop gateway
docker compose cp /path/to/usage-<date>.db sugar-db:/data/usage.db
docker compose start gateway
```

### Retention

Keep backups for 90 days. Delete backups older than 90 days via cron:

```bash
find /backups -name 'usage-*.db' -mtime +90 -delete
```

### Disaster Recovery

The usage database is the only stateful component. Everything else (gateway binary, Docker images, configuration) is reproducible from the source repository. In a total loss scenario:

1. Provision new host with Docker 24+
2. Clone the repository
3. Restore the latest usage.db backup
4. Run `docker compose up -d`

---

## 7. Troubleshooting

### /health Returns 503

The health endpoint itself is a lightweight liveness check that does not depend on external services, so a 503 on `/health` indicates the health server is not reachable. Check whether the gateway container is running:

```bash
docker compose ps
docker compose logs gateway
```

If the container is in a restart loop, see "Container Restart Loop" below.

### /ready Returns 503

The readiness check probes vault and sugar-db. A 503 response includes the specific dependency failure in the response body:

```json
{"status":"degraded","checks":{"vault":{"ok":false,"latencyMs":2000},"sugarDb":{"ok":true,"latencyMs":3}}}
```

Check the failing service:

```bash
docker compose ps
docker compose logs <failing-service>
```

Look for `vault: ok=false` or `sugarDb: ok=false` in the `/ready` response body or in the structured JSON logs.

### 429 on /v1/chat/completions

The `x-ratelimit-remaining` header will be `"0"`. The rate limiter has exhausted its token bucket for the calling client's key.

- Increase `GATEWAY_RATE_LIMIT_TOKENS` to allow more requests per window.
- Increase `GATEWAY_RATE_LIMIT_WINDOW_MS` to spread burst capacity over a longer interval.
- Check if a single client is making excessive requests.

### 401 on /v1/admin/*

Admin authentication is enabled (`GATEWAY_ADMIN_AUTH=true`) but the request is missing or has an incorrect `X-Admin-Token` header.

- Verify the request includes the `X-Admin-Token` header.
- Confirm the value matches `GATEWAY_ADMIN_TOKEN`.
- Check that `GATEWAY_ADMIN_TOKEN` is set in the gateway's environment (not empty).
- If using Caddy, confirm the `header_up X-Admin-Token` directive is present in the Caddyfile.

### Container Restart Loop

If the gateway container repeatedly restarts:

1. Check the health check log lines:
   ```bash
   docker compose logs gateway | grep -i health
   ```
2. Check the exit code and container logs:
   ```bash
   docker compose logs --tail=50 gateway
   ```
3. Common causes:
   - **OOM (Out of Memory)** — increase Docker memory limits for the gateway container.
   - **Upstream LLM timeout** — the health check passes but the main HTTP handler hangs on upstream provider calls. Check `GATEWAY_*_URL` env vars.
   - **Missing env var** — the gateway will fail to start if a critical env var is missing. Check logs for startup errors.

### No Providers Found for Model

If the `/v1/chat/completions` endpoint returns 502 with "No providers found", the translator worker could not resolve the requested model. Check:

- Is the iii Engine running and reachable at `III_URL`?
- Is the translator worker registered with the engine?
- Does the translator's model map include the requested model?
