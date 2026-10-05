FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS dashboard
WORKDIR /src/dashboard
COPY dashboard/package*.json ./
COPY dashboard/.npmrc ./
RUN npm ci
COPY help-center/package*.json /src/help-center/
RUN npm ci --prefix /src/help-center
COPY dashboard/ ./
COPY docs/user /src/docs/user
COPY contracts /src/contracts
COPY help-center /src/help-center
RUN npm run build

FROM rust:1.94-bookworm@sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55 AS server
WORKDIR /src/server
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src
COPY server/migrations ./migrations
# Compiled in with include_str!: the API reference and the Vector component catalog.
COPY contracts /src/contracts
COPY vector-catalog/catalog.json /src/vector-catalog/catalog.json
RUN cargo build --release --locked

# Agents for every supported platform, bundled so the server can hand devices
# a verified agent with no separate download step. The same reproducible
# flags as release builds; no archives, only binaries and their catalog.
FROM golang:1.26.8-bookworm@sha256:a688600ca24f8a4d3ca77f95b0dd40704a9fc787c826660eb7ba0b641b8b175d AS agents
RUN command -v python3 >/dev/null || (apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*)
WORKDIR /src
COPY agent/go.mod agent/go.sum ./agent/
RUN cd agent && go mod download
COPY agent ./agent
COPY packaging/build-release.py ./packaging/build-release.py
RUN python3 packaging/build-release.py --no-archives --out /out

FROM timberio/vector:0.58.0-debian@sha256:1c1ea358c617ea0b23003d5af87f7a678b30f8f7096437e680380c47fc13d2d9 AS validator
# The pinned Vector image can lag Debian security updates; refresh its installed packages.
USER root
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
COPY --from=server /src/server/target/release/vector-validator /usr/local/bin/vector-validator
USER 10002:10002
WORKDIR /tmp
ENV VECTORY_VECTOR_BINARY=/usr/bin/vector VECTORY_VALIDATOR_ADDR=0.0.0.0:8081
EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/vector-validator"]

# Keep the Bookworm build target while running on a patched Debian 13 base.
FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a AS runtime
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends ca-certificates curl python3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 vectory && useradd -u 10001 -g 10001 -M -s /usr/sbin/nologin vectory \
    && mkdir -p /var/lib/vectory /app/dashboard /app/operations /app/releases \
    && chown -R 10001:10001 /var/lib/vectory
COPY --from=server /src/server/target/release/vectory-server /usr/local/bin/vectory-server
COPY --from=server /src/server/target/release/vectory-admin /usr/local/bin/vectory-admin
COPY --from=dashboard /src/dashboard/dist /app/dashboard
# Bundled agents live apart from /app/releases, which an operator mirror may
# mount over; a mirror entry replaces the bundled build for its platform.
COPY --from=agents /out /app/agent-releases
COPY deploy/backup.py /app/operations/backup.py
USER 10001:10001
WORKDIR /app
ENV VECTORY_HTTP_ADDR=0.0.0.0:8080 VECTORY_AGENT_ADDR=0.0.0.0:8443 \
    VECTORY_DATA_DIR=/var/lib/vectory VECTORY_DASHBOARD_DIR=/app/dashboard \
    VECTORY_RELEASES_DIR=/app/releases VECTORY_BUNDLED_RELEASES_DIR=/app/agent-releases \
    VECTORY_COOKIE_SECURE=true
EXPOSE 8080 8443
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD curl --fail --silent http://127.0.0.1:8080/api/v1/status || exit 1
ENTRYPOINT ["vectory-server"]
