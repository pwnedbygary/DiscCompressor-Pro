import { clsx } from 'clsx'
import { Check, FolderOpen, RefreshCw, RotateCcw, Settings } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { TARGETS, TARGET_LABELS } from '@shared/formats'
import { SYSTEM_THEME_ID, THEMES, resolveTheme } from '@shared/themes'
import type { AppSettings, Target, ToolName, ToolStatus } from '@shared/types'
import { openOutputFolder } from '../actions'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { prefersDark } from '../lib/theme'
import { useAppSettings, useSettings } from '../store/settings'
import { toast } from '../store/toasts'
import { useUi } from '../store/ui'
import { Button, IconButton } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { Segmented, Select, Switch } from './ui/controls'

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {description && <p className="text-xs text-muted">{description}</p>}
      </div>
      <div className="divide-y divide-line rounded-xl border border-line bg-elevated">{children}</div>
    </section>
  )
}

function Row({ label, description, children }: { label: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">{label}</div>
        {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/

/**
 * A path field that saves when it loses focus or Enter is pressed. Paths must
 * be absolute; an invalid entry is flagged and reverted instead of saved.
 */
function PathInput({
  value,
  label,
  placeholder,
  onCommit,
  required = false
}: {
  value: string
  label: string
  placeholder: string
  onCommit: (value: string) => void
  required?: boolean
}) {
  const [draft, setDraft] = useState(value)
  const [committed, setCommitted] = useState(value)
  if (value !== committed) {
    setCommitted(value)
    setDraft(value)
  }
  const trimmed = draft.trim()
  const invalid = trimmed === '' ? required : !ABSOLUTE_PATH.test(trimmed)
  const commit = (): void => {
    if (invalid) setDraft(value)
    else if (trimmed !== value) onCommit(trimmed)
  }
  return (
    <input
      value={draft}
      aria-label={label}
      aria-invalid={invalid || undefined}
      title={invalid ? (trimmed === '' ? 'A folder is required' : 'Enter a full (absolute) path') : undefined}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === 'Enter' && commit()}
      className={clsx(
        'h-8 min-w-0 flex-1 rounded-lg border bg-bg px-2.5 font-mono text-xs outline-none placeholder:font-sans placeholder:text-muted focus-visible:border-accent',
        invalid ? 'border-danger' : 'border-line'
      )}
    />
  )
}

async function browse(pick: () => Promise<string | null>, apply: (path: string) => void): Promise<void> {
  try {
    const path = await pick()
    if (path) apply(path)
  } catch (error) {
    toast('error', 'Could not open the file picker', errorMessage(error))
  }
}

function ToolRow({ name, status, customPath, onReset }: { name: ToolName; status: ToolStatus | undefined; customPath: string; onReset: () => void }) {
  const chooseTool = useSettings((state) => state.chooseTool)
  const ok = !!status?.version && !status.error
  const source = status?.source === 'bundled' ? 'bundled with the app' : status?.source === 'system' ? 'found on PATH' : 'chosen by you'
  const choose = (): void => {
    chooseTool(name).catch((error: unknown) => toast('error', `Could not set ${name}`, errorMessage(error)))
  }
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className={clsx('size-2 rounded-full', !status ? 'bg-muted' : ok ? 'bg-success' : 'bg-danger')} />
        <span className="font-mono text-[13px] font-medium">{name}</span>
        <span className="text-xs text-muted">{status ? (ok ? `${status.version} · ${source}` : 'not available') : 'detecting…'}</span>
      </div>
      {status?.path && (
        <div className="truncate pl-4 font-mono text-2xs text-muted" title={status.path} data-selectable>
          {status.path}
        </div>
      )}
      {status?.error && <div className="pl-4 text-xs text-danger-ink">{status.error}</div>}
      <div className="flex gap-2 pl-4">
        <Button size="sm" onClick={choose}>
          Choose file…
        </Button>
        {customPath && (
          <Button size="sm" icon={RotateCcw} onClick={onReset}>
            Find automatically
          </Button>
        )}
      </div>
    </div>
  )
}

export function SettingsDialog() {
  const open = useUi((state) => state.settingsOpen)
  const setOpen = useUi((state) => state.setSettingsOpen)
  const settings = useAppSettings()
  const { update, tools, refreshTools, detectingTools } = useSettings()
  const platform = api.platform

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    update({ [key]: value }).catch((error: unknown) => toast('error', 'Could not save the setting', errorMessage(error)))
  }
  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title="Settings"
      description="Changes are saved automatically."
      icon={<Settings className="size-5" aria-hidden />}
      footer={
        <Button variant="primary" onClick={() => setOpen(false)}>
          Done
        </Button>
      }
    >
      <div className="space-y-7">
        <Section title="Output" description="Where finished images are written.">
          <div className="space-y-3 px-4 py-3">
            <Segmented
              label="Destination"
              value={settings.outputMode}
              onChange={(value) => set('outputMode', value)}
              options={[
                { value: 'directory', label: 'A single folder' },
                { value: 'source', label: 'Next to each source file' }
              ]}
            />
            {settings.outputMode === 'directory' && (
              <div className="flex gap-2">
                <PathInput value={settings.outputDirectory} label="Output folder" placeholder="Output folder" required onCommit={(value) => set('outputDirectory', value)} />
                <Button onClick={() => void browse(() => api.pickDirectory(settings.outputDirectory), (path) => set('outputDirectory', path))}>Browse…</Button>
                <IconButton icon={FolderOpen} label="Open folder" onClick={() => void openOutputFolder()} />
              </div>
            )}
          </div>
          <Row label="When the output already exists">
            <Select
              aria-label="When the output already exists"
              value={settings.overwrite}
              onChange={(event) => set('overwrite', event.target.value as AppSettings['overwrite'])}
              className="w-44"
            >
              <option value="overwrite">Replace it</option>
              <option value="skip">Skip the job</option>
              <option value="rename">Keep both (number it)</option>
            </Select>
          </Row>
        </Section>

        <Section title="Queue">
          <Row label="Format for new jobs" description="Compressed images (CHD, CSO, ZSO, DAX) start as extraction jobs.">
            <Select aria-label="Format for new jobs" value={settings.defaultTarget} onChange={(event) => set('defaultTarget', event.target.value as Target)} className="w-44">
              {TARGETS.map((target) => (
                <option key={target} value={target}>
                  {TARGET_LABELS[target]}
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Jobs at the same time" description="chdman and maxcso already use every core; parallel jobs mostly help with many small images.">
            <Select aria-label="Jobs at the same time" value={settings.maxConcurrentJobs} onChange={(event) => set('maxConcurrentJobs', Number(event.target.value))} className="w-44">
              {[1, 2, 3, 4].map((count) => (
                <option key={count} value={count}>
                  {count === 1 ? '1 (one after another)' : count}
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Move originals to the trash after success" description="Applies to conversions and extractions, never to Info or Verify. Files go to the trash, not straight to deletion.">
            <Switch label="Move originals to the trash" checked={settings.deleteOriginals} onChange={(value) => set('deleteOriginals', value)} />
          </Row>
          <Row label="Create .m3u playlists for multi-disc games" description={'Groups files named like "Game (Disc 1)" or "Game (Disc 1 of 2)".'}>
            <Switch label="Create playlists" checked={settings.autoGenerateM3U} onChange={(value) => set('autoGenerateM3U', value)} />
          </Row>
          <Row label="Notify when the queue finishes" description="Shows a desktop notification if the window is in the background.">
            <Switch label="Notify when finished" checked={settings.notifyOnFinish} onChange={(value) => set('notifyOnFinish', value)} />
          </Row>
          <Row
            label="Keep running in the system tray"
            description={platform === 'linux' ? 'Closing or minimizing hides the window. Needs a desktop with tray (StatusNotifier) support.' : 'Closing or minimizing hides the window to the tray.'}
          >
            <Switch label="Minimize to tray" checked={settings.minimizeToTray} onChange={(value) => set('minimizeToTray', value)} />
          </Row>
        </Section>

        <Section
          title="Tools"
          description="DiscCompressor Pro runs chdman (from MAME) and maxcso to do the actual work. Unless you choose a file, it looks for them among the app's files and then on the system PATH."
        >
          <ToolRow name="chdman" status={tools?.chdman} customPath={settings.chdmanPath} onReset={() => set('chdmanPath', '')} />
          <ToolRow name="maxcso" status={tools?.maxcso} customPath={settings.maxcsoPath} onReset={() => set('maxcsoPath', '')} />
          <div className="flex justify-end px-4 py-2.5">
            <Button size="sm" icon={RefreshCw} disabled={detectingTools} onClick={() => void refreshTools()}>
              {detectingTools ? 'Detecting…' : 'Detect again'}
            </Button>
          </div>
        </Section>

        <Section title="Appearance">
          <div className="grid grid-cols-3 gap-2 p-3">
            {[SYSTEM_THEME_ID, ...THEMES.map((theme) => theme.id)].map((id) => {
              const theme = resolveTheme(id, prefersDark())
              const selected = settings.themeId === id
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => set('themeId', id)}
                  aria-pressed={selected}
                  className={clsx(
                    'relative overflow-hidden rounded-lg border text-left transition-shadow',
                    selected ? 'border-accent shadow-[0_0_0_1px] shadow-accent' : 'border-line hover:border-line-strong'
                  )}
                >
                  <div className="flex h-12 items-end gap-1 p-2" style={{ background: theme.colors.bg }}>
                    <span className="h-5 flex-1 rounded" style={{ background: theme.colors.elevated, border: `1px solid ${theme.colors.border}` }} />
                    <span className="h-5 w-6 rounded" style={{ background: theme.colors.accent }} />
                  </div>
                  <div className="flex items-center justify-between px-2 py-1.5 text-xs" style={{ background: theme.colors.surface, color: theme.colors.text }}>
                    <span className="truncate">{id === SYSTEM_THEME_ID ? 'Match system' : theme.name}</span>
                    {selected && <Check className="size-3.5 shrink-0" aria-hidden />}
                  </div>
                </button>
              )
            })}
          </div>
        </Section>
      </div>
    </Dialog>
  )
}
