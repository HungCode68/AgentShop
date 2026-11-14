# Gateway: no npm dependencies (node:http + fetch + node:sqlite), so no install step.
FROM node:22-alpine

# NODE_OPTIONS:
#  - --disable-warning hides node:sqlite's ExperimentalWarning for the server and for `docker exec ... node src/cli.js`.
#  - --no-network-family-autoselection --dns-result-order=ipv4first: on the production server (Docker network without
#    working IPv6) Node 22's dual-stack "happy eyeballs" made every fetch to api.telegram.org fail with ETIMEDOUT while
#    plain IPv4 works. Connect over IPv4 first, without the parallel IPv4/IPv6 race.
ENV NODE_ENV=production \
    PORT=8090 \
    DB_PATH=/data/gateway.db \
    NODE_OPTIONS="--disable-warning=ExperimentalWarning --no-network-family-autoselection --dns-result-order=ipv4first"

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
