import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import postcssPresetEnv from "postcss-preset-env"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"],
  },
  css: {
    postcss: {
      plugins: [
        postcssPresetEnv({
          browsers: ["defaults", "Safari >= 15.2", "iOS >= 15.2"],
          enableClientSidePolyfills: false,
          minimumVendorImplementations: 0,
          stage: 3,
          features: {
            "cascade-layers": true,
            "color-mix": ["auto", { preserve: true }],
            "oklab-function": ["auto", { preserve: true }],
            "property-rule-prelude-list": true,
          },
        }),
      ],
    },
  },
  build: {
    outDir: "dist",
  },
})
