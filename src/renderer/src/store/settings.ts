import { create } from 'zustand'
import type { AppSettings, SystemInfo, ToolName, ToolsStatus } from '@shared/types'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { toast } from './toasts'

interface SettingsState {
  settings: AppSettings | null
  system: SystemInfo | null
  tools: ToolsStatus | null
  detectingTools: boolean
  load: () => Promise<void>
  update: (patch: Partial<AppSettings>) => Promise<void>
  /** Let the user pick the executable for a tool; the main process saves it. */
  chooseTool: (tool: ToolName) => Promise<void>
  refreshTools: () => Promise<void>
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: null,
  system: null,
  tools: null,
  detectingTools: false,

  async load() {
    const [settings, system] = await Promise.all([api.getSettings(), api.getSystemInfo()])
    set({ settings, system })
    void get().refreshTools()
  },

  async update(patch) {
    const previous = get().settings
    if (previous) set({ settings: { ...previous, ...patch } })
    try {
      set({ settings: await api.updateSettings(patch) })
    } catch (error) {
      set({ settings: previous })
      throw error
    }
    if ('chdmanPath' in patch || 'maxcsoPath' in patch) await get().refreshTools()
  },

  async chooseTool(tool) {
    const settings = await api.chooseTool(tool)
    if (!settings) return
    set({ settings })
    await get().refreshTools()
  },

  async refreshTools() {
    set({ detectingTools: true })
    try {
      set({ tools: await api.getTools(true) })
    } catch (error) {
      toast('error', 'Could not detect chdman and maxcso', errorMessage(error))
    } finally {
      set({ detectingTools: false })
    }
  }
}))

/** Settings are loaded before the UI renders, so this never returns null in components. */
export function useAppSettings(): AppSettings {
  return useSettings((state) => state.settings) as AppSettings
}
