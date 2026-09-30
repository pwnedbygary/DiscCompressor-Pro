import { ArrowDownToLine, ExternalLink, RefreshCw, RotateCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { REPOSITORY_URL, releaseUrl } from '@shared/project'
import type { UpdateStatus } from '@shared/types'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { formatPercent } from '../lib/format'
import { useQueue } from '../store/queue'
import { useAppSettings } from '../store/settings'
import { toast } from '../store/toasts'
import { useUi } from '../store/ui'
import { useUpdates } from '../store/updates'
import { Button } from './ui/Button'

function open(url: string): void {
  api.openExternal(url).catch((error: unknown) => toast('error', 'Could not open the release page', errorMessage(error)))
}

function pillLabel(status: UpdateStatus | null): string | null {
  switch (status?.state) {
    case 'available':
      return `Version ${status.version} is available`
    case 'downloading':
      return `Downloading update · ${formatPercent(status.progress ?? 0)}`
    case 'downloaded':
      return `Version ${status.version} is ready`
    default:
      return null
  }
}

/** Shown in the status bar while an update is available, downloading or ready; opens Help → About. */
export function UpdatePill() {
  const label = pillLabel(useUpdates((state) => state.status))
  if (!label) return null
  return (
    <button
      type="button"
      onClick={() => useUi.setState({ helpTab: 'about', helpOpen: true })}
      className="flex items-center gap-1.5 rounded-full bg-accent/12 px-2 py-0.5 font-medium text-accent-ink hover:bg-accent/20"
    >
      <ArrowDownToLine className="size-3" aria-hidden />
      {label}
    </button>
  )
}

/** The update status and what can be done about it, for Help → About. */
export function UpdatesCard() {
  const status = useUpdates((state) => state.status)
  const check = useUpdates((state) => state.check)
  const download = useUpdates((state) => state.download)
  const install = useUpdates((state) => state.install)
  const automatic = useAppSettings().checkForUpdates
  const busy = useQueue((state) => state.running || state.order.some((id) => state.jobs[id]?.status === 'running'))
  if (!status) return null

  const { support, state, version, error, failed } = status
  const checkButton = (label = 'Check now') => (
    <Button size="sm" icon={RefreshCw} onClick={() => void check()}>
      {label}
    </Button>
  )
  const releaseButton = (label: string, url = version ? releaseUrl(version) : `${REPOSITORY_URL}/releases/latest`) => (
    <Button size="sm" icon={ExternalLink} onClick={() => open(url)}>
      {label}
    </Button>
  )
  let summary: ReactNode
  let actions: ReactNode = null
  if (support === 'none') {
    summary = 'This copy of DiscCompressor Pro does not update itself. New versions are on the release page.'
    actions = releaseButton('Release page')
  } else if (state === 'checking') {
    summary = 'Checking for updates…'
  } else if (state === 'up-to-date') {
    summary = 'You have the latest version.'
    actions = checkButton()
  } else if (state === 'available' && version) {
    if (support === 'install') {
      summary = `Version ${version} is available.`
      actions = (
        <>
          {releaseButton('What’s new')}
          <Button size="sm" variant="primary" icon={ArrowDownToLine} onClick={() => void download()}>
            Download update
          </Button>
        </>
      )
    } else {
      summary = `Version ${version} is available. This copy cannot install it, so download it from the release page.`
      actions = releaseButton('Release page')
    }
  } else if (state === 'downloading') {
    // The progress bar reports the percentage; in the live text it would be read out every second.
    summary = (
      <>
        Downloading version {version}…<span aria-hidden> {formatPercent(status.progress ?? 0)}</span>
      </>
    )
  } else if (state === 'downloaded' && version) {
    summary = busy
      ? `Version ${version} is ready. Restart once the queue has finished, or it is installed when you quit.`
      : `Version ${version} is ready. Restart to install it now, or it is installed when you quit.`
    actions = (
      <>
        {releaseButton('What’s new')}
        <Button size="sm" variant="primary" icon={RotateCw} disabled={busy} onClick={() => void install()}>
          Restart to update
        </Button>
      </>
    )
  } else if (state === 'installing') {
    summary = `Restarting to install version ${version ?? ''}…`
  } else if (state === 'error' && failed === 'download') {
    summary = `The update could not be downloaded: ${error ?? 'unknown error'}`
    actions = (
      <Button size="sm" icon={RefreshCw} onClick={() => void download()}>
        Try again
      </Button>
    )
  } else if (state === 'error' && failed === 'install') {
    summary = `The update could not be installed: ${error ?? 'unknown error'}. Download it from the release page instead.`
    actions = releaseButton('Release page')
  } else if (state === 'error') {
    summary = `Could not check for updates: ${error ?? 'unknown error'}`
    actions = checkButton('Try again')
  } else {
    summary = automatic ? 'Checks for a new release when the app starts and once a day.' : 'Automatic checks are off (Settings → Updates).'
    actions = checkButton()
  }

  return (
    <div className="rounded-xl border border-line bg-elevated px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">Updates</h3>
          <p className="mt-1 text-muted" aria-live="polite" data-selectable>
            {summary}
          </p>
        </div>
        {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
      </div>
      {state === 'downloading' && (
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-subtle"
          role="progressbar"
          aria-label="Download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((status.progress ?? 0) * 100)}
        >
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${(status.progress ?? 0) * 100}%` }} />
        </div>
      )}
    </div>
  )
}
