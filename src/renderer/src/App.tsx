import { useEffect } from 'react'
import { addPaths } from './actions'
import { DropOverlay } from './components/DropOverlay'
import { Header } from './components/Header'
import { HelpDialog } from './components/HelpDialog'
import { Inspector } from './components/Inspector'
import { JobList } from './components/JobList'
import { LogPanel } from './components/LogPanel'
import { QueueToolbar } from './components/QueueToolbar'
import { SettingsDialog } from './components/SettingsDialog'
import { StatusBar } from './components/StatusBar'
import { Toasts } from './components/Toasts'
import { useFileDrop } from './hooks/useFileDrop'
import { useShortcuts } from './hooks/useShortcuts'
import { api } from './lib/api'
import { filesInUse, handleJobEvents, startQueue, stopQueue, watchActivity, watchScheduler } from './store/scheduler'
import { useUi } from './store/ui'

export function App() {
  useShortcuts()
  const dragging = useFileDrop()
  const logOpen = useUi((state) => state.logOpen)
  const inspectorOpen = useUi((state) => state.inspectorOpen)

  useEffect(() => {
    const unsubscribers = [
      api.onJobEvents(handleJobEvents),
      api.answerFilesInUse(filesInUse),
      api.onOpenPaths((paths) => void addPaths(paths)),
      api.onCommand((command) => {
        switch (command) {
          case 'start-queue':
            return startQueue()
          case 'stop-queue':
            return stopQueue()
          case 'open-settings':
            return useUi.getState().setSettingsOpen(true)
        }
      }),
      watchScheduler(),
      watchActivity()
    ]
    api.rendererReady()
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [])

  return (
    <div className="flex h-full flex-col">
      <Header />
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col bg-bg">
          <QueueToolbar />
          <JobList />
        </main>
        {inspectorOpen && <Inspector />}
      </div>
      {logOpen && <LogPanel />}
      <StatusBar />
      <SettingsDialog />
      <HelpDialog />
      <Toasts />
      {dragging && <DropOverlay />}
    </div>
  )
}
