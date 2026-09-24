import type { DiscApi } from '@shared/api'

declare global {
  interface Window {
    api: DiscApi
  }
  const __APP_VERSION__: string
}
