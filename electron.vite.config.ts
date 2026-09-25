import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

const sharedAlias = { '@shared': resolve('src/shared') }

const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

// The dev server injects an inline React Refresh preamble and talks to Vite over
// a websocket, neither of which the production policy allows.
const DEV_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws://localhost:* http://localhost:*",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'dcp-content-security-policy',
    transformIndexHtml: {
      order: 'pre',
      handler: (html, ctx) => html.replace('%CONTENT_SECURITY_POLICY%', ctx.server ? DEV_CSP : PRODUCTION_CSP)
    }
  }
}

const PACKAGE_PATH = /(?:^|[\\/])node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+/g

/**
 * Record the folders of the npm packages whose code or assets end up in a
 * bundle (such as node_modules/react, or a nested node_modules/a/node_modules/b),
 * for scripts/generate-notices.mjs. `extra` names packages that are compiled in
 * without leaving a module behind, such as Tailwind's base styles.
 */
function bundledPackages(bundle: string, extra: string[] = []): Plugin {
  let root = process.cwd()
  return {
    name: 'dcp-bundled-packages',
    apply: 'build',
    configResolved(config) {
      root = config.root
    },
    generateBundle(_options, output) {
      const packages = new Set(extra.map((name) => `node_modules/${name}`))
      // Module ids are absolute; the original names of assets are relative to Vite's root.
      const record = (id: string): void => {
        const path = resolve(root, id.replace(/^\0/, '').replace(/\?.*$/, ''))
        const last = [...path.matchAll(PACKAGE_PATH)].at(-1)
        if (last?.index === undefined) return
        packages.add(relative(process.cwd(), path.slice(0, last.index + last[0].length)).split(sep).join('/'))
      }
      for (const file of Object.values(output)) {
        if (file.type === 'chunk') Object.keys(file.modules).forEach(record)
        else file.originalFileNames.forEach(record)
      }
      const dir = resolve('node_modules/.cache/dcp')
      mkdirSync(dir, { recursive: true })
      writeFileSync(resolve(dir, `bundled-packages-${bundle}.json`), `${JSON.stringify([...packages].sort(), null, 2)}\n`)
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    plugins: [bundledPackages('main')]
  },
  preload: {
    resolve: { alias: sharedAlias },
    build: {
      // Sandboxed preload scripts cannot be ES modules.
      rollupOptions: { output: { format: 'cjs' } }
    },
    plugins: [bundledPackages('preload')]
  },
  renderer: {
    resolve: {
      alias: { ...sharedAlias, '@renderer': resolve('src/renderer/src') }
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    build: {
      minify: 'esbuild'
    },
    plugins: [react(), tailwindcss(), contentSecurityPolicy(), bundledPackages('renderer', ['tailwindcss'])]
  }
})
