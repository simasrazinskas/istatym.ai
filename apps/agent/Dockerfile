# syntax=docker/dockerfile:1

# ---- Base: Node 24 (eve requires >=24) + pnpm via Corepack ----
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---- Dependencies (cached on lockfile) ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---- Build: compile the agent and the Nitro host output ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm exec eve build

# ---- Runner: the self-contained Nitro output (no node_modules needed) ----
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 eve

# `eve build` produced a self-contained Nitro server under .output (the just-bash
# sandbox backend is vendored into .output/server/node_modules), so the runtime
# image carries no application node_modules.
COPY --from=build --chown=eve:nodejs /app/.output ./.output

# Durable workflow state (the bundled local-disk world) persists here; mount a
# named volume at this path so sessions survive restarts.
RUN mkdir -p /app/.workflow-data && chown eve:nodejs /app/.workflow-data
VOLUME ["/app/.workflow-data"]

USER eve
EXPOSE 3000

# /eve/v1/health is always public (skips route auth), so it is a valid liveness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/eve/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
