import { randomBytes } from 'node:crypto'
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

// Matches "(Disc 1)", "[Disk 2]" and TOSEC-style "(Disc 1 of 2)".
const DISC_TAG = /\s*[([]\s*Dis[ck]\s*\d+(?:\s*of\s*\d+)?\s*[)\]]/i

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** The game name shared by every disc of a set, or null if the name has no disc tag. */
export function playlistName(fileBase: string): string | null {
  if (!DISC_TAG.test(fileBase)) return null
  const name = fileBase.replace(DISC_TAG, '').trim()
  return name || null
}

/** Whether a playlist only lists discs of `game` in this format and folder, as the ones written here do. */
function isGenerated(content: string, game: string, ext: string): boolean {
  const entries = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  return entries.every(
    (entry) =>
      !/[\\/]/.test(entry) && extname(entry).toLowerCase() === ext.toLowerCase() && playlistName(basename(entry, extname(entry))) === game
  )
}

const pending = new Map<string, Promise<unknown>>()

/** Run tasks for the same folder one after another, so concurrent jobs cannot drop each other's discs. */
function inOrder<T>(key: string, task: () => Promise<T>): Promise<T> {
  const result = (pending.get(key) ?? Promise.resolve()).then(task)
  const settled = result.catch(() => undefined)
  pending.set(key, settled)
  void settled.then(() => {
    if (pending.get(key) === settled) pending.delete(key)
  })
  return result
}

export interface PlaylistResult {
  path: string
  /** False when an existing, hand-made playlist was left alone. */
  written: boolean
}

/**
 * Write "<game>.m3u" next to `outputFile`, listing every disc of the same game
 * and format found in that folder in natural order ("Disc 2" before "Disc 10").
 * A playlist that lists anything else was made by hand and is only replaced
 * when `replaceCustom` is set. Returns null if the file is not part of a disc set.
 */
export function updatePlaylist(outputFile: string, replaceCustom: boolean): Promise<PlaylistResult | null> {
  const ext = extname(outputFile)
  const game = playlistName(basename(outputFile, ext))
  if (!game) return Promise.resolve(null)
  const dir = dirname(outputFile)

  return inOrder(process.platform === 'win32' ? dir.toLowerCase() : dir, async () => {
    const discs = (await readdir(dir)).filter((name) => {
      if (extname(name).toLowerCase() !== ext.toLowerCase()) return false
      return playlistName(basename(name, extname(name))) === game
    })
    if (discs.length === 0) return null
    discs.sort(collator.compare)

    const path = join(dir, `${game}.m3u`)
    const existing = await readFile(path, 'utf8').catch(() => null)
    if (existing !== null && !replaceCustom && !isGenerated(existing, game, ext)) return { path, written: false }

    const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await writeFile(temp, `${discs.join('\n')}\n`, 'utf8')
      await rename(temp, path)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
    return { path, written: true }
  })
}
