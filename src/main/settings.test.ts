import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_JOB_SETTINGS } from '@shared/formats'
import { SettingsStore, defaultSettings, sanitizeSettings } from './settings'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dcp-settings-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('sanitizeSettings', () => {
  it('reads a v1 settings file', () => {
    const v1 = {
      outputDirectory: '/data/out',
      defaultFormat: 'CSOv2',
      themeId: 'gruvbox',
      deleteOriginals: true,
      autoGenerateM3U: true,
      minimizeToTray: true,
      chdmanPath: '/opt/mame/chdman',
      maxcsoPath: ''
    }
    expect(sanitizeSettings(v1, defaultSettings())).toMatchObject({
      outputDirectory: '/data/out',
      defaultTarget: 'CSOv2',
      themeId: 'gruvbox',
      deleteOriginals: true,
      autoGenerateM3U: true,
      minimizeToTray: true,
      chdmanPath: '/opt/mame/chdman',
      jobDefaults: DEFAULT_JOB_SETTINGS
    })
  })

  it('rejects invalid values field by field', () => {
    const base = defaultSettings()
    const result = sanitizeSettings(
      { outputDirectory: 'relative/path', themeId: 'nope', maxConcurrentJobs: 99, overwrite: 'maybe', chdmanPath: 'chdman', window: { width: 10, height: 10 } },
      base
    )
    expect(result).toMatchObject({
      outputDirectory: base.outputDirectory,
      themeId: base.themeId,
      maxConcurrentJobs: 1,
      overwrite: 'skip',
      chdmanPath: '',
      window: null
    })
  })
})

describe('SettingsStore', () => {
  it('persists updates atomically and survives a corrupt file', async () => {
    const file = join(dir, 'settings.json')
    await writeFile(file, '{ not json')
    const store = new SettingsStore(file)
    expect(await store.load()).toEqual(defaultSettings())
    await store.update({ themeId: 'nord', maxConcurrentJobs: 2 })
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ themeId: 'nord', maxConcurrentJobs: 2 })
    const reloaded = new SettingsStore(file)
    expect((await reloaded.load()).themeId).toBe('nord')
  })
})
