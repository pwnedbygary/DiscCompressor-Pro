import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type LogFilter = 'all' | 'warn' | 'error'
export type HelpTab = 'formats' | 'shortcuts' | 'about'

interface UiState {
  logOpen: boolean
  logHeight: number
  logFilter: LogFilter
  inspectorOpen: boolean
  settingsOpen: boolean
  helpOpen: boolean
  helpTab: HelpTab
  /** Number of folder or file scans in progress. */
  scanning: number
  setLogOpen: (open: boolean) => void
  setLogHeight: (height: number) => void
  setLogFilter: (filter: LogFilter) => void
  setInspectorOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setHelpOpen: (open: boolean) => void
  setHelpTab: (tab: HelpTab) => void
  trackScan: <T>(work: Promise<T>) => Promise<T>
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      logOpen: false,
      logHeight: 220,
      logFilter: 'all',
      inspectorOpen: true,
      settingsOpen: false,
      helpOpen: false,
      helpTab: 'formats',
      scanning: 0,
      setLogOpen: (logOpen) => set({ logOpen }),
      setLogHeight: (logHeight) => set({ logHeight: Math.round(logHeight) }),
      setLogFilter: (logFilter) => set({ logFilter }),
      setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      setHelpOpen: (helpOpen) => set({ helpOpen }),
      setHelpTab: (helpTab) => set({ helpTab }),
      trackScan: async (work) => {
        set((state) => ({ scanning: state.scanning + 1 }))
        try {
          return await work
        } finally {
          set((state) => ({ scanning: state.scanning - 1 }))
        }
      }
    }),
    {
      name: 'dcp-ui',
      partialize: ({ logOpen, logHeight, logFilter, inspectorOpen }) => ({ logOpen, logHeight, logFilter, inspectorOpen })
    }
  )
)
