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
  append: (entries: Omit<LogEntry, 'id'>[]) => void
  clear: () => void
}

let nextId = 1

export const useLog = create<LogState>((set) => ({
  entries: [],
  append(incoming) {
    if (incoming.length === 0) return
    set((state) => {
      const combined = state.entries.concat(incoming.map((entry) => ({ ...entry, id: nextId++ })))
      return { entries: combined.length > MAX_ENTRIES ? combined.slice(combined.length - MAX_ENTRIES) : combined }
    })
  },
  clear() {
    set({ entries: [] })
  }
}))

export function log(level: LogLevel, message: string, source: string | null = null): void {
  useLog.getState().append([{ time: Date.now(), level, message, source }])
}
