/**
 * Shared formatting policy for the root workspace.
 *
 * Keep this conservative: it mirrors the existing web-next settings while
 * making Tailwind class ordering available from the root.
 *
 * @type {import("prettier").Config}
 */
const config = {
  endOfLine: "lf",
  semi: false,
  singleQuote: false,
  tabWidth: 2,
  trailingComma: "es5",
  printWidth: 80,
  plugins: ["prettier-plugin-tailwindcss"],
  tailwindFunctions: ["cn", "cva"],
  tailwindStylesheet: "./packages/web-next/app/globals.css",
  overrides: [
    {
      files: "packages/web-next/**/*.{js,jsx,ts,tsx,css}",
      options: {
        tailwindStylesheet: "./packages/web-next/app/globals.css",
      },
    },
  ],
}

export default config
