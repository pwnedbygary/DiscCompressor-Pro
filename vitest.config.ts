import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Lets tests read the stylesheet as text (`?raw`); other CSS imports stay empty.
    css: { include: [/styles\/index\.css/] }
  }
})
