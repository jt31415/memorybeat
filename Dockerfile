# node:sqlite (server/db.js) needs Node 22+, so the base image floor is 22.
#
# Two stages so that building for the arm64 server never runs anything *as*
# arm64. Every RUN happens in the build stage on this machine's own platform
# ($BUILDPLATFORM); the runtime stage only copies files in. Without that, each
# RUN goes through QEMU emulation, which is slow and breaks outright whenever
# Docker Desktop loses its binfmt registration ("exec /bin/sh: exec format
# error").
#
# This only works because every dependency is plain JavaScript (express,
# socket.io), so node_modules built on x86 runs unchanged on arm64. A dependency
# with a native addon would need its install moved back into the runtime stage.

# ------------------------------------------------------------------- build
FROM --platform=$BUILDPLATFORM node:22-alpine AS build

WORKDIR /app

# Dependencies first so the layer survives source-only changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The song DB and the iTunes cache ship as a *seed*, not as the live data dir.
# /app/data is a volume, so anything copied straight there would be shadowed on
# first run and any runtime write (itunes-cache.json) lost on redeploy. The
# entrypoint copies seed -> volume for files that aren't there yet.
#
# The seed is catalogue only. prepare-seed.js drops any runtime-state tables the
# build machine's copy still carries (state.db itself is kept out of the build
# context by .dockerignore), so a reseed can never ship this machine's players.
COPY scripts ./scripts
COPY data ./data-seed
RUN node scripts/prepare-seed.js data-seed/memorybeat.db \
 && mkdir -p /app/data

# ----------------------------------------------------------------- runtime
FROM node:22-alpine

WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts

# Owned by node: a fresh named volume takes its ownership from this directory,
# and the server writes the database and cache into it.
COPY --from=build --chown=node:node /app/data-seed ./data-seed
COPY --from=build --chown=node:node /app/data ./data

# --chmod rather than a RUN chmod: the file comes off a Windows checkout with no
# exec bit, and a RUN here would need emulation.
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
