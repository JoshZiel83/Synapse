import type { FastifyInstance } from "fastify"

import { config } from "../../config/index.js"
import { getRenderedInstallerArtifacts } from "./install-command.js"

// Public, unauthenticated routes that serve the rendered installer scripts.
// No preHandler = no auth (the scripts carry no secrets; the pairing code /
// api-key are passed by the user as flags, never baked in). Served under
// /api/v1/ because nginx only proxies /api/, /ws, /mobile/ to the API.
//
// The bytes returned here are EXACTLY what getRenderedInstallerArtifacts hashes
// for the dashboard one-click command, so the client-side sha256 check matches.
export function registerInstallerRoutes(app: FastifyInstance): void {
  app.get("/api/v1/install.sh", async (_request, reply) => {
    const artifacts = getRenderedInstallerArtifacts({
      serverUrl: config.app.baseUrl,
      privateRegistry: config.remoteAgent.npmRegistryUrl,
    })
    if (!artifacts) {
      return reply
        .status(503)
        .type("text/plain; charset=utf-8")
        .send(
          "# Synapse one-click install is unavailable: this instance has no\n" +
            "# private npm registry configured (PUBLIC_NPM_REGISTRY_URL is empty).\n"
        )
    }
    return reply
      .type("text/x-shellscript")
      .header("Cache-Control", "no-store")
      .send(artifacts.scriptSh)
  })

  app.get("/api/v1/install.ps1", async (_request, reply) => {
    const artifacts = getRenderedInstallerArtifacts({
      serverUrl: config.app.baseUrl,
      privateRegistry: config.remoteAgent.npmRegistryUrl,
    })
    if (!artifacts) {
      return reply
        .status(503)
        .type("text/plain; charset=utf-8")
        .send(
          "# Synapse one-click install is unavailable: this instance has no\n" +
            "# private npm registry configured (PUBLIC_NPM_REGISTRY_URL is empty).\n"
        )
    }
    return reply
      .type("text/plain; charset=utf-8")
      .header("Cache-Control", "no-store")
      .send(artifacts.scriptPs1)
  })
}
