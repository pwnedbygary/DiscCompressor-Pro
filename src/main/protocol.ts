import { isAbsolute, join, normalize, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'

/**
 * The packaged renderer is served from app://renderer/ instead of file://,
 * following Electron's security recommendations: it gets a real origin and
 * cannot read arbitrary local files by URL.
 */
export const APP_SCHEME = 'app'
export const APP_HOST = 'renderer'
export const APP_URL = `${APP_SCHEME}://${APP_HOST}/index.html`

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }
  ])
}

export function serveRenderer(rendererDir: string): void {
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 })
    let pathname: string
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    const file = normalize(join(rendererDir, pathname === '/' ? 'index.html' : pathname))
    const rel = relative(rendererDir, file)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).toString())
  })
}
