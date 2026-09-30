import { create } from 'zustand'
import type { LogLevel } from '@shared/types'

export interface LogEntry {
  id: number
  time: number
  level: LogLevel
  message: string
  /** Name of the image the line belongs to, if any. */
  source: string | null
}

const MAX_ENTRIES = 5000

interface LogState {
  entries: LogEntry[]
  /** The id of the newest entry when the console was last open. */
  seenId: number
  append: (entries: Omit<LogEntry, 'id'>[]) => void
  clear: () => void
  markSeen: () => void
}

let nextId = 1

export const useLog = create<LogState>((set) => ({
  entries: [],
  seenId: 0,
  append(incoming) {
    if (incoming.length === 0) return
    set((state) => {
      const combined = state.entries.concat(incoming.map((entry) => ({ ...entry, id: nextId++ })))
      return { entries: combined.length > MAX_ENTRIES ? combined.slice(combined.length - MAX_ENTRIES) : combined }
    })
  },
  clear() {
    set({ entries: [] })
  },
  markSeen() {
    set((state) => {
      const newest = state.entries.at(-1)?.id ?? state.seenId
      return newest === state.seenId ? state : { seenId: newest }
    })
  }
}))

/** The worst of the warnings and errors logged since the console was last open, if any. */
export function unseenLevel({ entries, seenId }: Pick<LogState, 'entries' | 'seenId'>): 'warn' | 'error' | null {
  let level: 'warn' | null = null
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry || entry.id <= seenId) break
    if (entry.level === 'error') return 'error'
    if (entry.level === 'warn') level = 'warn'
  }
  return level
}

export function log(level: LogLevel, message: string, source: string | null = null): void {
  useLog.getState().append([{ time: Date.now(), level, message, source }])
}
