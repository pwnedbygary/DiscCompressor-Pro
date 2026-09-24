import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'

/** Jobs work inside "<output dir>/.dcp-XXXXXX" so finished files can be moved into place atomically. */
export const WORK_DIR_PREFIX = '.dcp-'
const WORK_DIR_NAME = /^\.dcp-[A-Za-z0-9]{6}$/

export interface WorkDirRegistry {
  add(dir: string): Promise<void>
  remove(dir: string): Promise<void>
}

/**
 * Records the work directories of running jobs in a small file, so the partial
 * output of jobs interrupted by a crash or power loss can be deleted the next
 * time the app starts, wherever it was written. Only directories this app
 * created are ever deleted.
 */
export class WorkDirJournal implements WorkDirRegistry {
  private readonly dirs = new Set<string>()
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  /**
   * Load the directories a previous run left behind and delete them in the
   * background. Entries that cannot be deleted yet (an unplugged drive, say)
   * are kept for the next start.
   */
  async open(): Promise<void> {
    let entries: unknown
    try {
      entries = JSON.parse(await readFile(this.file, 'utf8'))
    } catch {
      return
    }
    if (!Array.isArray(entries)) return
    const stale = entries.filter((dir): dir is string => typeof dir === 'string' && isAbsolute(dir) && WORK_DIR_NAME.test(basename(dir)))
    for (const dir of stale) this.dirs.add(dir)
    for (const dir of stale) {
      rm(dir, { recursive: true, force: true, maxRetries: 3 }).then(
        () => this.remove(dir),
        (error: unknown) => console.warn(`Could not remove the leftover work directory ${dir}`, error)
      )
    }
  }

  add(dir: string): Promise<void> {
    this.dirs.add(dir)
    return this.save()
  }

  remove(dir: string): Promise<void> {
    return this.dirs.delete(dir) ? this.save() : Promise.resolve()
  }

  private save(): Promise<void> {
    const content = JSON.stringify([...this.dirs])
    this.writes = this.writes
      .then(() => this.write(content))
      .catch((error: unknown) => console.error(`Could not update ${this.file}`, error))
    return this.writes
  }

  private async write(content: string): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, content, 'utf8')
    await rename(temp, this.file)
  }
}
