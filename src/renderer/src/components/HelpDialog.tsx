import { CircleHelp, ExternalLink } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { useSettings } from '../store/settings'
import { toast } from '../store/toasts'
import { useUi } from '../store/ui'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { Kbd, Segmented } from './ui/controls'

type Tab = 'formats' | 'shortcuts' | 'about'

function Topic({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      <div className="space-y-1.5 text-[13px] leading-relaxed text-muted">{children}</div>
    </section>
  )
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  const open = (): void => {
    api.openExternal(href).catch((error: unknown) => toast('error', 'Could not open the link', errorMessage(error)))
  }
  return (
    <button type="button" onClick={open} className="inline-flex items-center gap-1 font-medium text-accent-ink hover:underline">
      {children}
      <ExternalLink className="size-3" aria-hidden />
    </button>
  )
}

const SHORTCUTS: [string[], string][] = [
  [['Ctrl', 'O'], 'Add files'],
  [['Ctrl', 'Shift', 'O'], 'Add a folder'],
  [['Ctrl', 'Enter'], 'Start the queue'],
  [['Ctrl', '.'], 'Stop the queue'],
  [['Ctrl', 'A'], 'Select every job'],
  [['↑', '↓'], 'Move the selection (Shift extends it)'],
  [['Alt', '↑ / ↓'], 'Move the selected jobs up or down'],
  [['Ctrl', 'D'], 'Duplicate the selected jobs'],
  [['Ctrl', 'R'], 'Run the selected jobs again'],
  [['Delete'], 'Remove the selected jobs'],
  [['Esc'], 'Clear the selection'],
  [['Ctrl', 'L'], 'Show or hide the console'],
  [['Ctrl', 'I'], 'Show or hide job settings'],
  [['Ctrl', ','], 'Settings'],
  [['F1'], 'Help']
]

function Formats() {
  return (
    <div className="space-y-5">
      <Topic title="CHD — Compressed Hunks of Data">
        <p>
          MAME&apos;s lossless disc format, also read by many emulators. CD images (BIN/CUE, GDI) are stored with <code>createcd</code>; DVD images with{' '}
          <code>createdvd</code>. For a plain ISO you choose which in the job settings.
        </p>
        <p>
          A CHD can list up to four codecs and chdman keeps whichever makes each hunk smallest. LZMA compresses best, Zstandard decompresses fastest and FLAC
          suits CD audio. Hunk sizes must be multiples of 2,448 bytes for CDs (one sector plus subcode) or 2,048 bytes for DVDs.
        </p>
      </Topic>
      <Topic title="CSO, CSO v2 and ZSO">
        <p>
          Compressed ISOs made with maxcso, mainly for PSP and PS2 software. maxcso always uses maximum compression; the effort setting chooses which
          compression methods it tries. CSO uses deflate, ZSO uses LZ4 (faster to read, larger files) and CSO v2 can mix both. maxcso describes CSO v2 and ZSO
          as experimental, so check that your emulator or loader supports them.
        </p>
        <p>Many readers only accept 2,048-byte blocks, which is the default. Larger blocks shrink files by a few percent where they are supported.</p>
      </Topic>
      <Topic title="Extract">
        <p>
          Turns CHD back into BIN/CUE, GDI or ISO, and CSO/ZSO/DAX back into ISO. A CD becomes an ISO only if it has a single data track: audio tracks and
          Mode 2 Form 2 sectors (XA audio and video) cannot be stored in an ISO, so such discs stay BIN/CUE.
        </p>
      </Topic>
      <Topic title="Info and Verify">
        <p>Info prints a CHD&apos;s header and metadata to the console. Verify recomputes its checksums to detect corruption. Neither writes any files.</p>
      </Topic>
      <Topic title="Good to know">
        <p>
          Work happens in a hidden temporary folder inside the output folder, and finished files are moved into place only when a job succeeds, so a cancelled
          or failed job never leaves half-written images behind.
        </p>
      </Topic>
    </div>
  )
}

function Shortcuts() {
  return (
    <div className="divide-y divide-line rounded-xl border border-line bg-elevated">
      {SHORTCUTS.map(([keys, action]) => (
        <div key={action} className="flex items-center justify-between px-4 py-2 text-[13px]">
          <span>{action}</span>
          <span className="flex gap-1">
            {keys.map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </span>
        </div>
      ))}
    </div>
  )
}

function About() {
  const tools = useSettings((state) => state.tools)
  const system = useSettings((state) => state.system)
  return (
    <div className="space-y-5 text-[13px]">
      <div className="rounded-xl border border-line bg-elevated px-4 py-3">
        <div className="font-semibold">DiscCompressor Pro {__APP_VERSION__}</div>
        <div className="mt-1 text-muted">
          {system?.platform} · {system?.arch} · {system?.cpuCount} cores
        </div>
        <div className="mt-2 space-y-0.5 text-muted">
          <div>chdman {tools?.chdman.version ?? 'not found'}</div>
          <div>maxcso {tools?.maxcso.version ?? 'not found'}</div>
        </div>
      </div>
      <Topic title="Credits">
        <p>
          chdman is part of <Link href="https://www.mamedev.org/">MAME</Link>. maxcso is written by Unknown W. Brackets —{' '}
          <Link href="https://github.com/unknownbrackets/maxcso">github.com/unknownbrackets/maxcso</Link>.
        </p>
        <p>
          Report problems or request features at <Link href="https://github.com/pwnedbygary/DiscCompressor-Pro/issues">the project&apos;s issue tracker</Link>.
        </p>
      </Topic>
    </div>
  )
}

export function HelpDialog() {
  const open = useUi((state) => state.helpOpen)
  const setOpen = useUi((state) => state.setHelpOpen)
  const [tab, setTab] = useState<Tab>('formats')

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title="Help"
      description="Formats, shortcuts and version information"
      icon={<CircleHelp className="size-5" aria-hidden />}
      footer={
        <Button variant="primary" onClick={() => setOpen(false)}>
          Close
        </Button>
      }
    >
      <Segmented<Tab>
        label="Help topic"
        value={tab}
        onChange={setTab}
        className="mb-5"
        options={[
          { value: 'formats', label: 'Formats' },
          { value: 'shortcuts', label: 'Keyboard shortcuts' },
          { value: 'about', label: 'About' }
        ]}
      />
      {tab === 'formats' && <Formats />}
      {tab === 'shortcuts' && <Shortcuts />}
      {tab === 'about' && <About />}
    </Dialog>
  )
}
