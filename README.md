# Aigency Gateway

AI agent request routing and orchestration gateway.

## Development

Refer to `workers/gateway/README.md` for development setup instructions.

## Deployment

Run `docker compose up -d` from the repository root to start the full stack — sugar-db, vault, gateway, and Caddy reverse proxy. Verify the deployment with `curl -k https://127.0.0.1:8443/health` — a successful response returns `{"status":"ok","uptimeMs":...,"version":"..."}` with HTTP 200.

Full configuration, secret management, monitoring, backup, and troubleshooting guidance is available in the operations manual.

[See OPERATIONS.md for full deployment, configuration, secret management, monitoring, backup, and troubleshooting guidance.](docs/OPERATIONS.md)

## Testing

Run `pnpm test` in any worker directory to execute unit and integration tests.
