# Synapse Device Runtime — cloud-sandbox image. Mounted by e2b / k8s /
# whatever host_provider the API selected in PR #12's createCloudDevicePairing.
#
# The image runs `synapse-device bootstrap` once at first boot to exchange
# the injected SYNAPSE_BOOTSTRAP_TOKEN for long-term credentials, then
# transitions to `synapse-device run`.
#
# v3.0 ships filesystem + commandline + headless browser only — no CUA
# (spec §2 Non-Goals).

FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="synapse-device-runtime"
LABEL org.opencontainers.image.description="Synapse Device Runtime — cloud sandbox image"

ENV NODE_ENV=production

# Headless browser + frpc + ripgrep (for live fs_search).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       chromium \
       ca-certificates \
       curl \
       ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Install frpc (matches frps version in docker-compose.yml).
ARG FRP_VERSION=0.65.0
RUN curl -fSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz" \
      -o /tmp/frp.tgz \
  && tar -xzf /tmp/frp.tgz -C /tmp \
  && mv "/tmp/frp_${FRP_VERSION}_linux_amd64/frpc" /usr/local/bin/frpc \
  && chmod +x /usr/local/bin/frpc \
  && rm -rf /tmp/frp.tgz "/tmp/frp_${FRP_VERSION}_linux_amd64"

WORKDIR /opt/synapse-device

# Copy the pre-built @synapse/device-runtime + dependencies. The build
# context is the monorepo root; expect packages/device-runtime/dist and
# packages/device-protocol/dist already produced by `npm run build:device-runtime`.
COPY packages/device-runtime/package.json ./packages/device-runtime/package.json
COPY packages/device-runtime/dist ./packages/device-runtime/dist
COPY packages/device-protocol/package.json ./packages/device-protocol/package.json
COPY packages/device-protocol/dist ./packages/device-protocol/dist
COPY package.json package-lock.json ./

# fs-helper Rust sidecar. Build with `npm run build:fs-helper` (or
# `(cd sidecars/fs-helper && cargo build --release)`) before `docker build`.
# Tools requiring the helper (history/indexed search/extract) silently
# degrade when the binary is absent; live ripgrep search keeps working on
# its own.
COPY sidecars/fs-helper/target/release/synapse-device-fs-helper \
     /opt/synapse-device/sidecars/fs-helper/synapse-device-fs-helper

RUN npm install --omit=dev --no-audit --no-fund --workspaces=false \
  && ln -sf /opt/synapse-device/packages/device-runtime/dist/bin.js /usr/local/bin/synapse-device \
  && chmod +x /opt/synapse-device/packages/device-runtime/dist/bin.js

# Cloud bootstrap flow:
#   1. exchange $SYNAPSE_BOOTSTRAP_TOKEN for long-term keys via
#      synapse-device bootstrap;
#   2. run the daemon.
COPY packages/device-runtime/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV SYNAPSE_SERVER_ORIGIN=""
ENV SYNAPSE_BOOTSTRAP_TOKEN=""

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["run"]
