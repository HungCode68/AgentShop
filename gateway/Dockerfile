# Gateway: no npm dependencies (node:http + fetch + node:sqlite), so no install step.
FROM node:22-alpine

# NODE_OPTIONS hides node:sqlite's ExperimentalWarning for the server and for `docker exec ... node src/cli.js`.
ENV NODE_ENV=production \
    PORT=8090 \
    DB_PATH=/data/gateway.db \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

WORKDIR /app
COPY package.json ./
COPY src ./src

# /data holds the SQLite database (mounted as a named volume by docker compose).
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8090/healthz >/dev/null || exit 1

CMD ["node", "src/index.js"]
