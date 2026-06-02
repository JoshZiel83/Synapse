# Synapse Device Runtime — cloud-sandbox image (self-contained multi-stage).
#
# Run via the docker SandboxBackend (DooD) — or any host_provider. On first
# boot the entrypoint runs `synapse-device bootstrap` to exchange the injected
# SYNAPSE_BOOTSTRAP_TOKEN for long-term credentials, then `synapse-device run`.
#
# Self-contained: the TS packages and the Rust fs-helper are BUILT inside the
# image from source, so the build does NOT depend on pre-built dist on the host
# (the repo .dockerignore excludes **/dist) and is reproducible. Build context
# is the monorepo root.
#
# v3.0 ships filesystem + commandline + headless browser only — no CUA.

# ── TS builder: compile device-protocol → shared → device-runtime ────────────
FROM node:22-bookworm-slim AS ts-builder
WORKDIR /build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
RUN git init >/dev/null 2>&1 || true
RUN npm config set registry https://registry.npmmirror.com \
  && npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 120000
# All workspace manifests so npm ci can validate the lockfile.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/device-protocol/package.json packages/device-protocol/
COPY packages/shared/package.json packages/shared/
COPY packages/device-runtime/package.json packages/device-runtime/
COPY packages/device-sdk/package.json packages/device-sdk/
COPY packages/device-runtime-bundles-linux-x64/package.json packages/device-runtime-bundles-linux-x64/
COPY packages/device-runtime-bundles-linux-arm64/package.json packages/device-runtime-bundles-linux-arm64/
COPY packages/device-runtime-bundles-darwin-x64/package.json packages/device-runtime-bundles-darwin-x64/
COPY packages/device-runtime-bundles-darwin-arm64/package.json packages/device-runtime-bundles-darwin-arm64/
COPY packages/device-runtime-bundles-win32-x64/package.json packages/device-runtime-bundles-win32-x64/
COPY packages/device-runtime-bundles-win32-arm64/package.json packages/device-runtime-bundles-win32-arm64/
COPY packages/api/package.json packages/api/
COPY packages/remote-agent-daemon/package.json packages/remote-agent-daemon/
COPY packages/web-next/package.json packages/web-next/
RUN npm ci --legacy-peer-deps --ignore-scripts \
      --workspace=packages/device-protocol \
      --workspace=packages/shared \
      --workspace=packages/device-runtime \
      --include-workspace-root
COPY packages/device-protocol/ packages/device-protocol/
COPY packages/shared/ packages/shared/
COPY packages/device-runtime/ packages/device-runtime/
RUN npm run build -w packages/device-protocol \
  && npm run build -w packages/shared \
  && npm run build -w packages/device-runtime

# ── Rust builder: compile the fs-helper sidecar ──────────────────────────────
FROM rust:1-bookworm AS fs-helper-builder
WORKDIR /build
COPY sidecars/fs-helper/ sidecars/fs-helper/
RUN cd sidecars/fs-helper && cargo build --release --locked

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="synapse-device-runtime"
LABEL org.opencontainers.image.description="Synapse Device Runtime — cloud sandbox image"

ENV NODE_ENV=production

# Headless browser + frpc + ripgrep (live fs_search) + bubblewrap (the
# --cmd-sandbox jail; without it the device fail-closes to NO commandline tool).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       chromium \
       ca-certificates \
       curl \
       ripgrep \
       bubblewrap \
  && rm -rf /var/lib/apt/lists/*

ARG FRP_VERSION=0.65.0
RUN curl -fSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz" \
      -o /tmp/frp.tgz \
  && tar -xzf /tmp/frp.tgz -C /tmp \
  && mv "/tmp/frp_${FRP_VERSION}_linux_amd64/frpc" /usr/local/bin/frpc \
  && chmod +x /usr/local/bin/frpc \
  && rm -rf /tmp/frp.tgz "/tmp/frp_${FRP_VERSION}_linux_amd64"

WORKDIR /opt/synapse-device

# Built TS packages (dist) + their package.json from the ts-builder, plus the
# root manifests so `npm install --omit=dev` resolves runtime deps.
COPY --from=ts-builder /build/package.json /build/package-lock.json ./
COPY --from=ts-builder /build/packages/device-runtime/package.json ./packages/device-runtime/package.json
COPY --from=ts-builder /build/packages/device-runtime/dist ./packages/device-runtime/dist
COPY --from=ts-builder /build/packages/shared/package.json ./packages/shared/package.json
COPY --from=ts-builder /build/packages/shared/dist ./packages/shared/dist
COPY --from=ts-builder /build/packages/device-protocol/package.json ./packages/device-protocol/package.json
COPY --from=ts-builder /build/packages/device-protocol/dist ./packages/device-protocol/dist

# fs-helper Rust sidecar (history / indexed search / extract).
COPY --from=fs-helper-builder \
     /build/sidecars/fs-helper/target/release/synapse-device-fs-helper \
     /opt/synapse-device/sidecars/fs-helper/synapse-device-fs-helper

RUN npm install --omit=dev --no-audit --no-fund --workspaces=false --ignore-scripts \
  && ln -sf /opt/synapse-device/packages/device-runtime/dist/bin.js /usr/local/bin/synapse-device \
  && chmod +x /opt/synapse-device/packages/device-runtime/dist/bin.js

COPY packages/device-runtime/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV SYNAPSE_SERVER_ORIGIN=""
ENV SYNAPSE_BOOTSTRAP_TOKEN=""

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["run"]
