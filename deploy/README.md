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

## Continuous deployment

`.github/workflows/deploy.yml` is a manual (`workflow_dispatch`) job that SSHes to the VM and runs
`docker compose pull && up -d`. It needs these repo secrets:

- `VM_HOST` — the VM hostname/IP
- `VM_USER` — the SSH user
- `VM_SSH_KEY` — a private key authorized on the VM

The GHCR package must be **public** for the VM to pull without authentication
(Packages → istatym → visibility → public), or add a registry login on the VM.

## Image

- Built from `apps/web/Dockerfile` (Next.js standalone output).
- Listens on port 3000; exposes `/api/health` for the container healthcheck and Traefik.
- Runtime config:
  - `DATABASE_URL` — Postgres connection string (required for retrieval; the compose file wires it
    to the `db` service). Without it the app boots but skips migrations and serves no results.
  - `ANTHROPIC_API_KEY` — optional; without it the app serves Postgres retrieval results and a
    "model not configured" notice instead of generated answers.
