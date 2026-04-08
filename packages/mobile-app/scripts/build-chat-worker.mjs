import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");

await build({
  absWorkingDir: packageRoot,
  entryPoints: [resolve(packageRoot, "src/workers/chat-service-worker.ts")],
  outfile: resolve(packageRoot, "public/chat-service-worker.js"),
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
});
