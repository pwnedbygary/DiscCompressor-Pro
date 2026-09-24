import { clsx } from 'clsx'
import { FolderOpen } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { ToolStatus } from '@shared/types'
import { openOutputFolder } from '../actions'
import { displayPath, formatPercent } from '../lib/format'
import { useQueue } from '../store/queue'
import { useAppSettings, useSettings } from '../store/settings'
import { useUi } from '../store/ui'

function ToolPill({ status, name }: { status: ToolStatus | undefined; name: string }) {
  const setSettingsOpen = useUi((state) => state.setSettingsOpen)
  const ok = !!status?.version && !status.error
  const title = status ? (status.error ?? `${status.path} (${status.source})`) : 'Detecting…'
  return (
    <button type="button" onClick={() => setSettingsOpen(true)} title={title} className="flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-hover">
      <span className={clsx('size-1.5 rounded-full', !status ? 'bg-muted' : ok ? 'bg-success' : 'bg-danger')} />
      <span className="font-medium">{name}</span>
      <span className="text-muted">{status ? (ok ? status.version : 'missing') : '…'}</span>
    </button>
  )
}

export function StatusBar() {
  const settings = useAppSettings()
  const tools = useSettings((state) => state.tools)
  const homeDir = useSettings((state) => state.system?.homeDir)
  const { running, active, progress } = useQueue(
    useShallow((state) => {
      let active = 0
      let sum = 0
      let measured = 0
      for (const id of state.order) {
        const job = state.jobs[id]
        if (job?.status !== 'running') continue
        active += 1
        if (job.progress !== null) {
          sum += job.progress
          measured += 1
        }
      }
      return { running: state.running, active, progress: measured > 0 ? sum / measured : null }
    })
  )

  return (
    <footer className="flex h-7 shrink-0 items-center gap-2 border-t border-line bg-surface px-2 text-2xs">
      <ToolPill status={tools?.chdman} name="chdman" />
      <ToolPill status={tools?.maxcso} name="maxcso" />
      <div className="mx-1 h-3.5 w-px bg-line" />
      {settings.outputMode === 'source' ? (
        <span className="px-1.5 text-muted">Output: next to each source file</span>
      ) : (
        <button type="button" onClick={() => void openOutputFolder()} className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-muted hover:bg-hover hover:text-fg" title={settings.outputDirectory}>
          <FolderOpen className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{displayPath(settings.outputDirectory, homeDir)}</span>
        </button>
      )}
      <div className="flex-1" />
      <span className="flex items-center gap-2 px-1.5">
        <span className={clsx('size-1.5 rounded-full', active > 0 ? 'animate-pulse bg-accent' : running ? 'bg-warning' : 'bg-muted')} />
        {active > 0 && !running ? (
          <span>Stopping…</span>
        ) : active > 0 ? (
          <span>
            Processing {active} job{active === 1 ? '' : 's'}
            {progress !== null && <span className="text-muted tabular-nums"> · {formatPercent(progress)}</span>}
          </span>
        ) : (
          <span className="text-muted">{running ? 'Starting…' : 'Idle'}</span>
        )}
      </span>
    </footer>
  )
}
