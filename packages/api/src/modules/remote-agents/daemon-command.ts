// Builds the daemon install/run command shown on the dashboard.
//
// Extracted into its own side-effect-free module so it can be unit
// tested without importing service.ts (which pulls in the database
// layer). See daemon-command.test.ts.

export interface DaemonCommandOptions {
  serverUrl: string
  apiKey: string
  /**
   * EXTERNAL-reachable npm registry URL (PUBLIC_NPM_REGISTRY_URL). When
   * set, the command pins BOTH `--registry` and `--@synapse:registry` so
   * the end user's machine resolves @synapse/remote-agent-daemon from the
   * private registry instead of public npmjs. The scope-specific flag is
   * essential: for a SCOPED package npm routes on the @synapse:registry
   * mapping, which OVERRIDES a plain `--registry` — so a stale/hostile
   * `@synapse:registry` in the user's ~/.npmrc would otherwise pull from
   * the wrong registry. When empty, the command assumes the user has
   * @synapse:registry configured in their own ~/.npmrc and invokes the
   * installed bin directly.
   */
  npmRegistryUrl?: string
}

export function buildDaemonCommand(opts: DaemonCommandOptions): string {
  const base = `--server-url ${opts.serverUrl} --api-key ${opts.apiKey}`
  const registry = opts.npmRegistryUrl?.trim()
  if (registry) {
    return `npm exec --yes --registry=${registry} --@synapse:registry=${registry} --package=@synapse/remote-agent-daemon -- synapse-remote-agent-daemon ${base}`
  }
  return `synapse-remote-agent-daemon ${base}`
}
