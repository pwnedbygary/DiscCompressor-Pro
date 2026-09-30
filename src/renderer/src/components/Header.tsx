import { clsx } from 'clsx'
import { CircleHelp, FolderPlus, LoaderCircle, PanelRight, Play, Plus, Settings, Square, SquareTerminal } from 'lucide-react'
import { pickAndAdd } from '../actions'
import iconUrl from '../assets/icon-small.png'
import { unseenLevel, useLog } from '../store/log'
import { startQueue, stopQueue } from '../store/scheduler'
import { useQueue } from '../store/queue'
import { useUi } from '../store/ui'
import { Button, IconButton } from './ui/Button'
import { ThemeMenu } from './ThemeMenu'

function QueueButton() {
  const running = useQueue((state) => state.running)
  const hasQueued = useQueue((state) => state.order.some((id) => state.jobs[id]?.status === 'queued'))
  const hasRunning = useQueue((state) => state.order.some((id) => state.jobs[id]?.status === 'running'))

  if (running) {
    return (
      <Button variant="danger" icon={Square} onClick={stopQueue} title="Stop the queue (Ctrl+.)">
        Stop
      </Button>
    )
  }
  if (hasRunning) {
    return (
      <Button variant="secondary" icon={LoaderCircle} disabled title="Waiting for the running jobs to stop">
        Stopping…
      </Button>
    )
  }
  return (
    <Button variant="success" icon={Play} onClick={startQueue} disabled={!hasQueued} title={hasQueued ? 'Process the queue (Ctrl+Enter)' : 'Nothing is queued'}>
      Start queue
    </Button>
  )
}

export function Header() {
  const logOpen = useUi((state) => state.logOpen)
  const unseen = useLog((state) => (logOpen ? null : unseenLevel(state)))
  const inspectorOpen = useUi((state) => state.inspectorOpen)
  const setLogOpen = useUi((state) => state.setLogOpen)
  const setInspectorOpen = useUi((state) => state.setInspectorOpen)
  const setSettingsOpen = useUi((state) => state.setSettingsOpen)
  const setHelpOpen = useUi((state) => state.setHelpOpen)

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-4 lg:gap-3">
      <div className="flex min-w-0 items-center gap-2.5 pr-2">
        <img src={iconUrl} alt="" className="size-8 drop-shadow-sm" draggable={false} />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[14px] font-semibold tracking-tight">DiscCompressor Pro</div>
          <div className="text-2xs text-muted">v{__APP_VERSION__}</div>
        </div>
      </div>

      <div className="mx-1 h-6 w-px bg-line" />

      <div className="flex items-center gap-2">
        <Button variant="primary" icon={Plus} onClick={() => void pickAndAdd('files')} title="Add disc images (Ctrl+O)">
          Add files
        </Button>
        <Button icon={FolderPlus} onClick={() => void pickAndAdd('folder')} title="Add every disc image in a folder (Ctrl+Shift+O)">
          Add folder
        </Button>
      </div>

      <div className="mx-1 h-6 w-px bg-line" />

      <QueueButton />

      <div className="flex-1" />

      <div className="flex items-center gap-0.5">
        <ThemeMenu />
        <span className="relative flex">
          <IconButton
            icon={SquareTerminal}
            label={unseen ? `Console (new ${unseen === 'error' ? 'errors' : 'warnings'})` : 'Console'}
            shortcut="Ctrl+L"
            tooltip
            pressed={logOpen}
            onClick={() => setLogOpen(!logOpen)}
          />
          {unseen && (
            <span
              className={clsx('pointer-events-none absolute top-1 right-1 size-2 rounded-full ring-2 ring-surface', unseen === 'error' ? 'bg-danger-ink' : 'bg-warning-ink')}
              aria-hidden
            />
          )}
        </span>
        <IconButton icon={PanelRight} label="Job settings" shortcut="Ctrl+I" tooltip pressed={inspectorOpen} onClick={() => setInspectorOpen(!inspectorOpen)} />
        <IconButton icon={Settings} label="Settings" shortcut="Ctrl+," tooltip onClick={() => setSettingsOpen(true)} />
        <IconButton icon={CircleHelp} label="Help" shortcut="F1" tooltip onClick={() => setHelpOpen(true)} />
      </div>
    </header>
  )
}
