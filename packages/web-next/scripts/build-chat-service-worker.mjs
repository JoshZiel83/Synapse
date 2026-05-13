import { build } from "esbuild"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, "..")

await build({
  absWorkingDir: packageRoot,
  entryPoints: [resolve(packageRoot, "lib/workers/web-chat-service-worker.ts")],
  outfile: resolve(packageRoot, "public/web-chat-service-worker.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  charset: "utf8",
  legalComments: "none",
  logLevel: "info",
  sourcemap: false,
  banner: {
    js: "/* eslint-disable */",
  },
})
