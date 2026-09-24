import { useVirtualizer } from '@tanstack/react-virtual'
import { clsx } from 'clsx'
import { ArrowDownToLine, ClipboardCopy, Eraser, FileDown, Search, X } from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { LogLevel } from '@shared/types'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { formatTime } from '../lib/format'
import { type LogEntry, useLog } from '../store/log'
import { toast } from '../store/toasts'
import { type LogFilter, useUi } from '../store/ui'
import { IconButton } from './ui/Button'
import { Segmented } from './ui/controls'

const LEVEL_STYLE: Record<LogLevel, string> = {
  info: 'text-fg',
  output: 'text-muted',
  success: 'text-success-ink',
  warn: 'text-warning-ink',
  error: 'text-danger-ink'
}

const LEVEL_BAR: Record<LogLevel, string> = {
  info: 'bg-info/60',
  output: 'bg-transparent',
  success: 'bg-success',
  warn: 'bg-warning',
  error: 'bg-danger'
}

const MIN_HEIGHT = 120

function matchesFilter(entry: LogEntry, filter: LogFilter): boolean {
  if (filter === 'error') return entry.level === 'error'
  if (filter === 'warn') return entry.level === 'warn' || entry.level === 'error'
  return true
}

function highlight(text: string, query: string): ReactNode {
  if (!query) return text
  const lower = text.toLowerCase()
  const parts: ReactNode[] = []
  let from = 0
  let index = lower.indexOf(query)
  while (index >= 0) {
    if (index > from) parts.push(text.slice(from, index))
    parts.push(
      <mark key={index} className="rounded-sm bg-accent/35 text-inherit">
        {text.slice(index, index + query.length)}
      </mark>
    )
    from = index + query.length
    index = lower.indexOf(query, from)
  }
  parts.push(text.slice(from))
  return parts
}

function formatEntry(entry: LogEntry): string {
  return `[${formatTime(entry.time)}] ${entry.level.toUpperCase().padEnd(7)} ${entry.source ? `${entry.source}: ` : ''}${entry.message}`
}

export function LogPanel() {
  const entries = useLog((state) => state.entries)
  const clear = useLog((state) => state.clear)
  const logHeight = useUi((state) => state.logHeight)
  const setLogHeight = useUi((state) => state.setLogHeight)
  const logFilter = useUi((state) => state.logFilter)
  const setLogFilter = useUi((state) => state.setLogFilter)
  const setLogOpen = useUi((state) => state.setLogOpen)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())
  const [follow, setFollow] = useState(true)
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const scroller = useRef<HTMLDivElement>(null)

  const visible = useMemo(
    () => entries.filter((entry) => matchesFilter(entry, logFilter) && (!deferredQuery || `${entry.source ?? ''} ${entry.message}`.toLowerCase().includes(deferredQuery))),
    [entries, logFilter, deferredQuery]
  )

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 20,
    overscan: 12,
    getItemKey: (index) => visible[index]?.id ?? index
  })

  // Keyed on the newest line rather than the count, which stops changing once the log is full.
  const newestId = visible.at(-1)?.id
  useEffect(() => {
    if (follow && visible.length > 0) virtualizer.scrollToIndex(visible.length - 1, { align: 'end' })
  }, [follow, newestId, visible.length, virtualizer])

  const onScroll = (): void => {
    const element = scroller.current
    if (!element) return
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24
    if (atBottom !== follow) setFollow(atBottom)
  }

  const [viewportHeight, setViewportHeight] = useState(window.innerHeight)
  useEffect(() => {
    const onResize = (): void => setViewportHeight(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // The console always leaves 260 px for the rest of the window; the stored height is kept for a larger window.
  const maxHeight = Math.max(MIN_HEIGHT, viewportHeight - 260)
  const clampHeight = (value: number): number => Math.round(Math.min(Math.max(value, MIN_HEIGHT), maxHeight))
  const height = clampHeight(dragHeight ?? logHeight)

  // The height is only stored (and persisted) when the drag ends.
  const startResize = (event: ReactMouseEvent): void => {
    event.preventDefault()
    const startY = event.clientY
    let latest = height
    const move = (e: MouseEvent): void => {
      latest = clampHeight(height + startY - e.clientY)
      setDragHeight(latest)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      setDragHeight(null)
      setLogHeight(latest)
    }
    document.body.style.cursor = 'row-resize'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const resizeWithKeys = (event: ReactKeyboardEvent): void => {
    const step = event.key === 'ArrowUp' ? 24 : event.key === 'ArrowDown' ? -24 : 0
    if (step === 0) return
    event.preventDefault()
    setLogHeight(clampHeight(height + step))
  }

  const copyAll = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(visible.map(formatEntry).join('\n'))
      toast('success', `Copied ${visible.length} line${visible.length === 1 ? '' : 's'}`)
    } catch (error) {
      toast('error', 'Could not copy the console', errorMessage(error))
    }
  }

  const saveAll = async (): Promise<void> => {
    try {
      await api.saveText({
        title: 'Save console log',
        defaultName: `disccompressor-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.log`,
        filters: [{ name: 'Log files', extensions: ['log', 'txt'] }],
        content: `${entries.map(formatEntry).join('\n')}\n`
      })
    } catch (error) {
      toast('error', 'Could not save the log', errorMessage(error))
    }
  }

  return (
    <section className="relative flex shrink-0 flex-col border-t border-line bg-surface" style={{ height }}>
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-label="Resize console"
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={maxHeight}
        aria-valuenow={height}
        aria-valuetext={`${height} pixels`}
        onMouseDown={startResize}
        onKeyDown={resizeWithKeys}
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize outline-offset-0 hover:bg-accent/30 focus-visible:bg-accent/30"
      />
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line px-3">
        <span className="text-[13px] font-semibold">Console</span>
        <Segmented<LogFilter>
          label="Filter"
          size="sm"
          value={logFilter}
          onChange={setLogFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'warn', label: 'Warnings' },
            { value: 'error', label: 'Errors' }
          ]}
        />
        <div className="relative w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the console"
            aria-label="Search the console"
            className="h-7 w-full rounded-md border border-line bg-elevated pr-7 pl-7 text-xs outline-none placeholder:text-muted focus-visible:border-accent"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted hover:text-fg">
              <X className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
        <span className="text-2xs text-muted tabular-nums">
          {visible.length === entries.length ? `${entries.length} lines` : `${visible.length} of ${entries.length}`}
        </span>
        <div className="flex-1" />
        <IconButton icon={ArrowDownToLine} label="Follow new lines" size="sm" pressed={follow} onClick={() => setFollow(!follow)} />
        <IconButton icon={ClipboardCopy} label="Copy visible lines" size="sm" disabled={visible.length === 0} onClick={() => void copyAll()} />
        <IconButton icon={FileDown} label="Save log…" size="sm" disabled={entries.length === 0} onClick={() => void saveAll()} />
        <IconButton icon={Eraser} label="Clear console" size="sm" disabled={entries.length === 0} onClick={clear} />
        <IconButton icon={X} label="Hide console" size="sm" onClick={() => setLogOpen(false)} />
      </div>
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto py-1 font-mono text-xs" data-selectable>
        {visible.length === 0 ? (
          <div className="px-4 py-3 font-sans text-muted italic">{entries.length === 0 ? 'Nothing logged yet.' : 'No lines match.'}</div>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const entry = visible[item.index] as LogEntry
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 flex w-full gap-3 py-px pr-4 pl-3 hover:bg-subtle"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <span className={clsx('mt-[3px] w-0.5 shrink-0 self-stretch rounded-full', LEVEL_BAR[entry.level])} />
                  <span className="shrink-0 text-muted tabular-nums">{formatTime(entry.time)}</span>
                  {entry.source && (
                    <span className="max-w-48 shrink-0 truncate text-muted" title={entry.source}>
                      {entry.source}
                    </span>
                  )}
                  <span className={clsx('min-w-0 flex-1 break-words whitespace-pre-wrap', LEVEL_STYLE[entry.level])}>{highlight(entry.message, deferredQuery)}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
