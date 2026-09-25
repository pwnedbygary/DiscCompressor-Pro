import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAppUrl, isExternalLink } from './window'

vi.mock('electron', () => ({ app: { isPackaged: true }, BrowserWindow: class {}, nativeTheme: {}, screen: {}, shell: {}, net: {}, protocol: {} }))

afterEach(() => {
  delete process.env.ELECTRON_RENDERER_URL
})

describe('isAppUrl', () => {
  it('accepts only the app pages, although their URL origin is the opaque "null"', () => {
    expect(new URL('app://renderer/index.html').origin).toBe('null')
    expect(isAppUrl('app://renderer/index.html')).toBe(true)
    expect(isAppUrl('app://renderer/assets/index.js')).toBe(true)
    for (const url of ['file:///etc/passwd', 'data:text/html,hi', 'about:blank', 'app://other/index.html', 'https://github.com/', 'not a url']) {
      expect(isAppUrl(url)).toBe(false)
    }
  })

  it('ignores the dev server variable in a packaged build', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    expect(isAppUrl('http://localhost:5173/')).toBe(false)
    expect(isAppUrl('app://renderer/index.html')).toBe(true)
  })
})

describe('isExternalLink', () => {
  it('allows only https links to the sites the app refers to', () => {
    expect(isExternalLink('https://github.com/unknownbrackets/maxcso')).toBe(true)
    expect(isExternalLink('https://www.mamedev.org/')).toBe(true)
    for (const url of ['http://github.com/', 'https://github.com.example.com/', 'https://example.com/', 'file:///tmp/x', 'javascript:alert(1)']) {
      expect(isExternalLink(url)).toBe(false)
    }
  })
})
