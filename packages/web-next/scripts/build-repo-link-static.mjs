import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { copyFile, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(scriptDir, "..")
const workspaceRoot = resolve(webRoot, "..", "..")
const tempRoot = join(webRoot, ".next", "repo-link-static")
const tempOutDir = join(tempRoot, "out")
const finalOutDir = join(webRoot, "out")

const rootLayoutSource = `import type { Metadata } from "next"
import type { ReactNode } from "react"
import { Manrope, Space_Grotesk } from "next/font/google"

import "./globals.css"

function resolveMetadataBase() {
  const candidates = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? \`https://\${process.env.VERCEL_PROJECT_PRODUCTION_URL}\`
      : undefined,
    process.env.VERCEL_URL ? \`https://\${process.env.VERCEL_URL}\` : undefined,
    "http://localhost:3000",
  ]

  for (const candidate of candidates) {
    if (!candidate) continue

    try {
      return new URL(candidate)
    } catch {
      continue
    }
  }

  return new URL("http://localhost:3000")
}

const sans = Manrope({
  subsets: ["latin"],
  variable: "--font-sans",
})

const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
})

export const metadata: Metadata = {
  metadataBase: resolveMetadataBase(),
  title: {
    default: "Synapse",
    template: "%s | Synapse",
  },
  description: "让 AI 成为拥有岗位、记忆、权限与协作关系的数字员工组织。",
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "Synapse",
    description: "云端数字员工组织运行时。",
    images: ["/synapse.png"],
  },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className={[sans.variable, display.variable, "font-sans antialiased"].join(
        " "
      )}
    >
      <body className="min-h-screen bg-background text-foreground">
        {children}
      </body>
    </html>
  )
}
`

const nextConfigSource = `/** @type {import("next").NextConfig} */
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  outputFileTracingRoot: resolve(__dirname, "..", "..", "..", ".."),
  experimental: {
    webpackBuildWorker: false,
  },
}

export default nextConfig
`

const tsconfigSource = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2017",
      lib: ["dom", "dom.iterable", "esnext"],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: "esnext",
      moduleResolution: "bundler",
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: "react-jsx",
      incremental: true,
      plugins: [{ name: "next" }],
      baseUrl: ".",
      paths: {
        "@/*": ["./*"],
      },
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
    exclude: ["node_modules"],
  },
  null,
  2
)

const packageJsonSource = JSON.stringify(
  {
    name: "web-next-repo-link-static",
    private: true,
    type: "module",
    scripts: {
      build: "next build --webpack",
    },
  },
  null,
  2
)

async function writeTempFile(relativePath, source) {
  const target = join(tempRoot, relativePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, source)
}

async function copyTempFile(relativePath) {
  const source = join(webRoot, relativePath)
  const target = join(tempRoot, relativePath)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
}

async function copyMatchingFiles(sourceDir, shouldCopy) {
  const entries = await readdir(join(webRoot, sourceDir), {
    withFileTypes: true,
  })

  for (const entry of entries) {
    if (!entry.isFile() || !shouldCopy(entry.name)) continue
    await copyTempFile(join(sourceDir, entry.name))
  }
}

async function copyPublicAssets() {
  for (const publicFile of [
    "apple-touch-icon.png",
    "favicon.ico",
    "synapse.png",
    "synapse.svg",
  ]) {
    await copyTempFile(`public/${publicFile}`)
  }
}

async function prepareTempApp() {
  await rm(tempRoot, { recursive: true, force: true })
  await rm(finalOutDir, { recursive: true, force: true })
  await mkdir(tempRoot, { recursive: true })

  await writeTempFile("package.json", packageJsonSource)
  await writeTempFile("next.config.mjs", nextConfigSource)
  await writeTempFile("tsconfig.json", `${tsconfigSource}\n`)
  await copyTempFile("postcss.config.mjs")
  await copyPublicAssets()

  await writeTempFile("app/layout.tsx", rootLayoutSource)
  await copyTempFile("app/globals.css")
  await copyTempFile("app/page.tsx")
  await copyTempFile("app/m/layout.tsx")
  await copyTempFile("app/m/page.tsx")

  await copyMatchingFiles(
    "components",
    (name) => name.startsWith("landing-") && name.endsWith(".tsx")
  )
  await copyTempFile("components/desktop-mobile-hint.tsx")
  await copyTempFile("components/repo-link-static-redirect.tsx")
  await copyMatchingFiles("components/mobile-landing", (name) =>
    name.endsWith(".tsx")
  )

  for (const uiFile of ["avatar.tsx", "badge.tsx", "button.tsx", "card.tsx"]) {
    await copyTempFile(`components/ui/${uiFile}`)
  }

  await copyTempFile("lib/repo-link-mode.ts")
  await copyTempFile("lib/is-mobile-user-agent.ts")
  await copyTempFile("lib/utils.ts")
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    })

    child.on("error", rejectRun)
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun()
        return
      }

      rejectRun(
        new Error(
          signal
            ? `${command} exited with signal ${signal}`
            : `${command} exited with code ${code}`
        )
      )
    })
  })
}

async function buildTempApp() {
  const nextBin = join(
    workspaceRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "next.cmd" : "next"
  )
  const command = existsSync(nextBin) ? nextBin : "next"

  await run(command, ["build", "--webpack"], {
    cwd: tempRoot,
    env: {
      ...process.env,
      NEXT_PUBLIC_SYNAPSE_REPO_LINK_MODE: "1",
    },
  })
}

async function publishOutput() {
  await rm(finalOutDir, { recursive: true, force: true })
  await cp(tempOutDir, finalOutDir, { recursive: true })
}

async function main() {
  await prepareTempApp()
  await buildTempApp()
  await publishOutput()
  console.log(`Repo-link static export written to ${finalOutDir}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
