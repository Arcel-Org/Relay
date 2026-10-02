# Base image pinned by digest, not the mutable :20-alpine tag — a plain tag
# means `docker build` silently pulls whatever node:20-alpine upstream has
# most recently published, including a live CVE, with no review. Verified
# against Docker Hub's registry API and cross-checked with `docker manifest
# inspect node:20-alpine`; re-pin deliberately (same digest across all 4
# stages below) when actually upgrading.
ARG BASE_IMAGE=node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

# ---------------------------------------------------------------------------
# Stage 1 – deps: install production + dev dependencies (cached layer)
# ---------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# Stage 1b – prod-deps: production-only install for the relay service.
# The relay (server/relay-node.ts) is never traced by Next's standalone
# output (it isn't part of the page graph), so it needs its own runtime
# node_modules (ws, etc.) — this keeps that install to production deps only.
# ---------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Stage 2 – build: compile the Next.js application AND the relay server.
# ts-node/typescript are devDependencies and are never present in the
# runtime image, so the relay must ship as plain compiled JS, not run via
# `npx ts-node` at runtime (that previously couldn't work at all — no
# ts-node, no typescript, no package.json in the runtime stage).
# ---------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next.js inlines every NEXT_PUBLIC_* var into the client bundle at `next
# build` time via static string substitution — it is NOT read at runtime in
# the browser. Without this ARG/ENV, `npm run build` below would run with
# NEXT_PUBLIC_RELAY_URL unset, baking lib/messaging/connection.ts's fallback
# ('ws://localhost:3000', meaningless to a real browser) into every deployed
# client bundle regardless of whatever docker-compose.yml sets at container
# runtime — the app would build and start fine, then fail to connect to the
# relay for every real user. Pass the real value via `docker compose build
# --build-arg` or docker-compose.yml's `build.args` (see that file).
ARG NEXT_PUBLIC_RELAY_URL
ENV NEXT_PUBLIC_RELAY_URL=$NEXT_PUBLIC_RELAY_URL

RUN npm run build
RUN npm run build:relay

# ---------------------------------------------------------------------------
# Stage 3 – runtime: slim image with only what is needed to run
# ---------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
# Next's standalone server binds to process.env.HOSTNAME || '0.0.0.0'. Docker
# injects HOSTNAME=<container-id> for every container, which resolves to the
# container's eth0 IP — NOT 127.0.0.1 — so the server would refuse the
# healthcheck's http://localhost:3000 probe (and any loopback connection)
# while still answering on the published port. Pinning to 0.0.0.0 binds all
# interfaces, loopback included; this is the documented Next.js-in-Docker fix.
ENV HOSTNAME=0.0.0.0

# Non-root user — a future RCE (dependency vuln, deserialization bug, etc.)
# should not get root-equivalent access to the container filesystem or the
# mounted app-data volume.
#
# The marker file is load-bearing, NOT a typo: Docker initialises a FRESH
# named volume from the image's directory at the mount point, and an EMPTY
# directory's volume comes up owned by root (mode 755) regardless of any
# chown — the non-root relay user then cannot create relay.db and every
# SQLite-backed route fails with SQLITE_CANTOPEN. A single relay-owned file
# makes the whole fresh volume initialize as relay:relay instead. It must be
# created BEFORE the VOLUME instruction below (writes after VOLUME are
# discarded at build time) and outside the image COPY path. The marker is 0
# bytes and harmless at runtime. (An entrypoint that chowned at boot was
# considered and rejected: compose drops ALL capabilities, so root in the
# container cannot chown either — CAP_CHOWN is gone.)
RUN addgroup -S relay && adduser -S relay -G relay \
    && mkdir -p /app/.data \
    && touch /app/.data/.docker-volume-marker \
    && chown -R relay:relay /app/.data

# Copy the standalone server (includes only necessary node_modules)
COPY --from=build /app/.next/standalone ./

# Copy static assets that standalone mode does not bundle
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# The standalone server (`.next/standalone/server.js`, now at /app/server.js)
# is the production entrypoint. Deliberately NOT the repo's custom server.js:
# that file `require('next')`s and builds its own Next instance to add a
# same-origin WebSocket→relay proxy — a dev/PM2 convenience that needs the
# full `next` package (including next/dist/compiled/webpack), which
# standalone output intentionally does not ship. In the containerized
# deployment the browser never uses a same-origin WS path: NEXT_PUBLIC_RELAY_URL
# is a real public `wss://` URL (baked at build time above) that clients
# connect to directly, and the reverse proxy routes it to the relay service.
# Keeping the standalone server here avoids pulling in modules the image
# would otherwise not contain (and that were never traced into standalone).

# Compiled relay server (plain JS — see build:relay) plus its own
# production-only node_modules (ws etc., not traced into standalone above).
# Placed at dist-server/node_modules so Node's normal upward module
# resolution from dist-server/server/relay-node.js finds it with no
# NODE_PATH tricks needed.
COPY --from=build /app/dist-server ./dist-server
COPY --from=prod-deps /app/node_modules ./dist-server/node_modules

# Persist user data
VOLUME ["/app/.data"]

RUN chown -R relay:relay /app
USER relay

EXPOSE 3000

CMD ["node", "server.js"]
