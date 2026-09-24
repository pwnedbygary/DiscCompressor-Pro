import { join } from 'node:path'
import { BrowserWindow, type Rectangle, app, nativeTheme, screen, shell } from 'electron'
import { resolveTheme } from '@shared/themes'
import type { AppSettings, WindowState } from '@shared/types'
import { iconPath } from './paths'
import { APP_HOST, APP_SCHEME, APP_URL } from './protocol'

const DEFAULT_SIZE = { width: 1280, height: 840 }
const MIN_SIZE = { width: 940, height: 600 }

/** Use saved bounds only if they are still mostly on a connected display. */
function restoreBounds(state: WindowState | null): Partial<Rectangle> {
  if (!state) return DEFAULT_SIZE
  const size = { width: Math.max(state.width, MIN_SIZE.width), height: Math.max(state.height, MIN_SIZE.height) }
  if (state.x === undefined || state.y === undefined) return size
  const bounds = { x: state.x, y: state.y, ...size }
  const area = screen.getDisplayMatching(bounds).workArea
  const visibleWidth = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
  const visibleHeight = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
  return visibleWidth >= 200 && visibleHeight >= 100 ? bounds : size
}

/** electron-vite's dev server, which is never used by a packaged build. */
function devServerUrl(): string | undefined {
  return app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
}

/**
 * Whether a URL is one of the app's own pages. The scheme and host are
 * compared directly because a custom scheme's URL origin is the opaque
 * "null", which file:, data: and about: pages share.
 */
export function isAppUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const dev = devServerUrl()
  if (dev) return parsed.origin === new URL(dev).origin
  return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST
}

/** Sites the app links to (the help dialog); no other page is ever opened. */
const EXTERNAL_HOSTS = new Set(['github.com', 'www.mamedev.org'])

export function isExternalLink(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && EXTERNAL_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

export function createMainWindow(settings: AppSettings, onStateChange: (state: WindowState) => void): BrowserWindow {
  const theme = resolveTheme(settings.themeId, nativeTheme.shouldUseDarkColors)
  const window = new BrowserWindow({
    ...restoreBounds(settings.window),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: 'DiscCompressor Pro',
    backgroundColor: theme.colors.bg,
    show: false,
    ...(process.platform === 'darwin' ? {} : { icon: iconPath('icon.png') }),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  window.once('ready-to-show', () => {
    if (settings.window?.maximized) window.maximize()
    window.show()
  })

  let saveTimer: NodeJS.Timeout | undefined
  const saveState = (): void => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (window.isDestroyed() || window.isMinimized()) return
      const bounds = window.getNormalBounds()
      onStateChange({ ...bounds, maximized: window.isMaximized() })
    }, 400)
  }
  window.on('resize', saveState)
  window.on('move', saveState)
  window.on('maximize', saveState)
  window.on('unmaximize', saveState)

  // The renderer never navigates away; links to the web open in the default browser.
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLink(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const dev = devServerUrl()
  if (dev) {
    void window.loadURL(dev)
    window.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key === 'I'))) {
        window.webContents.toggleDevTools()
      }
    })
  } else {
    void window.loadURL(APP_URL)
  }
  return window
}
