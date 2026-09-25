import { ChevronRight, FolderOpen } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { openOutput } from '../../actions'
import { fileName, formatBytes, formatNumber } from '../../lib/format'
import { INPUT_LABELS, type Job, MEDIA_LABELS } from '../../lib/jobs'
import { IconButton } from '../ui/Button'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1">
      <dt className="w-24 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  )
}

const MAX_TRACKS_SHOWN = 8

export function InputDetails({ job }: { job: Job }) {
  const [open, setOpen] = useState(true)
  const { input } = job
  const tracks = input.tracks.slice(0, MAX_TRACKS_SHOWN)

  return (
    <section className="rounded-xl border border-line bg-elevated">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left" aria-expanded={open}>
        <ChevronRight className={`size-4 text-muted transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
        <span className="text-2xs font-semibold tracking-wide text-muted uppercase">Image details</span>
      </button>
      {open && (
        <dl className="border-t border-line px-3 py-2 text-xs">
          <Row label="Type">{INPUT_LABELS[input.kind]}</Row>
          <Row label="Size">
            {formatBytes(input.size)} <span className="text-muted">({formatNumber(input.size)} bytes)</span>
          </Row>
          {input.media && <Row label="Media">{MEDIA_LABELS[input.media]}</Row>}
          {input.chd && (
            <>
              <Row label="CHD">
                Version {input.chd.version} · {input.chd.codecs.join(', ')}
              </Row>
              <Row label="Hunk size">{formatNumber(input.chd.hunkBytes)} bytes</Row>
              <Row label="Data size">{formatBytes(input.chd.logicalBytes)}</Row>
            </>
          )}
          {input.ciso && (
            <>
              <Row label="Format">{input.ciso.format.toUpperCase().replace('CSO1', 'CSO v1').replace('CSO2', 'CSO v2')}</Row>
              <Row label="Block size">{formatNumber(input.ciso.blockSize)} bytes</Row>
              <Row label="ISO size">{formatBytes(input.ciso.uncompressedBytes)}</Row>
            </>
          )}
          {tracks.length > 0 && (
            <Row label={`Tracks (${input.tracks.length})`}>
              <ul className="space-y-0.5 font-mono text-2xs">
                {tracks.map((track) => (
                  <li key={track.number} className="truncate" title={track.file}>
                    {String(track.number).padStart(2, '0')} {track.type}
                    {track.sectorSize > 0 && <span className="text-muted"> · {track.sectorSize}</span>}
                  </li>
                ))}
                {input.tracks.length > tracks.length && <li className="text-muted">and {input.tracks.length - tracks.length} more</li>}
              </ul>
            </Row>
          )}
          <Row label="Location">
            <span data-selectable className="font-mono text-2xs">
              {input.path}
            </span>
          </Row>
          {input.files.length > 1 && (
            <Row label="Track files">
              <span data-selectable className="font-mono text-2xs">
                {input.files.slice(1).map(fileName).join(', ')}
              </span>
            </Row>
          )}
          {input.problem && (
            <Row label="Problem">
              <span className="text-danger-ink">{input.problem}</span>
            </Row>
          )}
          {job.status === 'failed' && job.error && job.error !== input.problem && (
            <Row label="Error">
              <span data-selectable className="break-words text-danger-ink">
                {job.error}
              </span>
            </Row>
          )}
          {job.outputs.length > 0 && (
            <Row label="Output">
              <ul className="space-y-1">
                {job.outputs.map((output) => (
                  <li key={output} className="flex items-center gap-1">
                    <span data-selectable className="min-w-0 flex-1 truncate font-mono text-2xs" title={output}>
                      {fileName(output)}
                    </span>
                    <IconButton icon={FolderOpen} label="Show in folder" size="sm" onClick={() => void openOutput(output)} />
                  </li>
                ))}
              </ul>
            </Row>
          )}
        </dl>
      )}
    </section>
  )
}
