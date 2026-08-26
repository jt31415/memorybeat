# node:sqlite (server/db.js) needs Node 22+, so the base image floor is 22.
FROM node:22-alpine

WORKDIR /app

# Dependencies first so the layer survives source-only changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public
COPY scripts ./scripts

# The song DB and the iTunes cache ship as a *seed*, not as the live data dir.
# /app/data is a volume, so anything copied straight there would be shadowed on
# first run and any runtime write (itunes-cache.json) lost on redeploy. The
# entrypoint copies seed -> volume for files that aren't there yet.
COPY data ./data-seed
RUN mkdir -p /app/data && chown -R node:node /app/data /app/data-seed

# chmod explicitly: the file comes off a Windows checkout with no exec bit.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
