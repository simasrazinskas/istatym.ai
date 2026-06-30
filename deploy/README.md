# Deployment

The web app is built into a container image by CI (`.github/workflows/ci.yml`) and pushed to
`ghcr.io/simasrazinskas/istatym`.
It is hosted on the VM behind the existing Traefik reverse proxy, served at https://istatym.ai.

The stack now has two services (see `compose.yaml`): the `app` container and a self-hosted
`db` (ParadeDB = Postgres + pgvector + pg_search). The app runs schema migrations and, on first
boot with an empty database, ingests the current Darbo kodeksas consolidation from the
data.gov.lt Spinta API. The database lives on the internal Docker network only — it is never
exposed to the proxy or the public internet — and persists in the `pgdata` named volume.

## One-time VM setup

The VM already runs Traefik (v2.11) on an external Docker network named `proxy`, with a
`letsencrypt` cert resolver. To add this service:

```sh
# on the VM
mkdir -p ~/istatym
# copy deploy/compose.yaml from this repo to ~/istatym/compose.yaml
umask 077
{
  printf 'ANTHROPIC_API_KEY=sk-ant-...\n'
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)"   # generated once; never rotate casually
  printf 'ROUTE_AUTH_BASIC_USER=istatym\n'
  printf 'ROUTE_AUTH_BASIC_PASSWORD=%s\n' "$(openssl rand -hex 24)"  # operator creds for the agent endpoint
} > ~/istatym/.env   # not committed; chmod 600
cd ~/istatym
docker compose pull
docker compose up -d
```

`POSTGRES_PASSWORD` is baked into the database volume the first time `db` starts; if you change
it later you must also reset the `pgdata` volume (or `ALTER ROLE` inside Postgres). On first boot
the `app` migrates the schema and ingests ~263 Darbo kodeksas articles — check `docker compose logs app`
for `[startup] applied migrations` and `[ingest] bootstrapped`. To force a re-ingest later, run
`docker compose exec app node` is not available (standalone image has no pnpm); instead re-ingest
from a dev machine with `DATABASE_URL` pointed at the VM, or delete the work row and restart `app`.

Traefik picks up the `app` container via its labels (`Host(istatym.ai)`, `websecure`, `letsencrypt`)
and issues the TLS certificate on first request. The `db` service carries no Traefik labels and
stays on the internal network. No other service on the box is touched.

### Agent runtime (`agent` service)

The self-hosted eve agent is served at `https://agent.istatym.ai` on its own host. A single Traefik
`Host(agent.istatym.ai)` router forwards **every** path to it — both `/eve/` and the durable-run
callback at `/.well-known/workflow/v1/flow` — which is required: a path-restricted proxy that drops
the callback lets sessions start but stalls runs forever. Point an `agent.istatym.ai` DNS A record at
the VM before deploying; Traefik issues its TLS cert on first request.

Durable session state (the bundled local-disk workflow world) lives in the `agent_workflow_data`
volume, so sessions survive container restarts. The endpoint is gated by HTTP Basic
(`ROUTE_AUTH_BASIC_USER` / `ROUTE_AUTH_BASIC_PASSWORD`); `/eve/v1/health` stays public for probes.
Smoke-test a turn:

```sh
curl -u "$ROUTE_AUTH_BASIC_USER:$ROUTE_AUTH_BASIC_PASSWORD" \
  -X POST https://agent.istatym.ai/eve/v1/session \
  -H 'content-type: application/json' -d '{"message":"Call ping and report the token."}'
```

## Continuous deployment

`.github/workflows/deploy.yml` is a manual (`workflow_dispatch`) job that SSHes to the VM and runs
`docker compose pull && up -d`. It needs these repo secrets:

- `VM_HOST` — the VM hostname/IP
- `VM_USER` — the SSH user
- `VM_SSH_KEY` — a private key authorized on the VM

The GHCR package must be **public** for the VM to pull without authentication
(Packages → istatym → visibility → public), or add a registry login on the VM.

## Images

Two images are built and pushed by CI:

- `ghcr.io/simasrazinskas/istatym` — the web app (`apps/web`).
- `ghcr.io/simasrazinskas/istatym-agent` — the eve agent runtime (`apps/agent`).

Both GHCR packages must be **public** for the VM to pull without authentication.

### Web image

- Built from `apps/web/Dockerfile` (Next.js standalone output).
- Listens on port 3000; exposes `/api/health` for the container healthcheck and Traefik.
- Runtime config:
  - `DATABASE_URL` — Postgres connection string (required for retrieval; the compose file wires it
    to the `db` service). Without it the app boots but skips migrations and serves no results.
  - `ANTHROPIC_API_KEY` — optional; without it the app serves Postgres retrieval results and a
    "model not configured" notice instead of generated answers.
