import { create } from 'zustand'
import type { UpdateStatus } from '@shared/types'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { toast } from './toasts'

interface UpdatesState {
  status: UpdateStatus | null
  check: () => Promise<void>
  download: () => Promise<void>
  install: () => Promise<void>
}

export const useUpdates = create<UpdatesState>((set) => ({
  status: null,

  async check() {
    try {
      set({ status: await api.checkForUpdates() })
    } catch (error) {
      toast('error', 'Could not check for updates', errorMessage(error))
    }
  },

  async download() {
    try {
      await api.downloadUpdate()
    } catch (error) {
      toast('error', 'Could not download the update', errorMessage(error))
    }
  },

  async install() {
    try {
      await api.installUpdate()
    } catch (error) {
      toast('error', 'Could not install the update', errorMessage(error))
    }
  }
}))

/** Follow the main process's update status; returns the function that stops. */
export function watchUpdates(): () => void {
  let pushed = false
  const stop = api.onUpdateStatus((status) => {
    pushed = true
    useUpdates.setState({ status })
  })
  api
    .getUpdateStatus()
    .then((status) => {
      // A status pushed in the meantime is newer.
      if (!pushed) useUpdates.setState({ status })
    })
    .catch((error: unknown) => console.error('Could not read the update status', error))
  return stop
}
