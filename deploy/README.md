# Deployment

The web app is built into a container image by CI (`.github/workflows/ci.yml`) and pushed to
`ghcr.io/simasrazinskas/istatym`.
It is hosted on the VM behind the existing Traefik reverse proxy, served at https://istatym.ai.

## One-time VM setup

The VM already runs Traefik (v2.11) on an external Docker network named `proxy`, with a
`letsencrypt` cert resolver. To add this service:

```sh
# on the VM
mkdir -p ~/istatym
# copy deploy/compose.yaml from this repo to ~/istatym/compose.yaml
printf 'ANTHROPIC_API_KEY=sk-ant-...\n' > ~/istatym/.env   # not committed; chmod 600
cd ~/istatym
docker compose pull
docker compose up -d
```

Traefik picks up the container via its labels (`Host(istatym.ai)`, `websecure`, `letsencrypt`)
and issues the TLS certificate on first request. No other service is touched.

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
- Runtime config: `ANTHROPIC_API_KEY` (optional — without it the app serves retrieval results
  and a "model not configured" notice instead of generated answers).
