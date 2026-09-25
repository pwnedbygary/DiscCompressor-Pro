import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias }
  },
  preload: {
    resolve: { alias: sharedAlias },
    build: {
      // Sandboxed preload scripts cannot be ES modules.
      rollupOptions: { output: { format: 'cjs' } }
    }
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
    plugins: [react(), tailwindcss(), contentSecurityPolicy()]
  }
})
