import { type Range, defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { type DragEvent, type KeyboardEvent, type MouseEvent, useCallback, useEffect, useRef, useState } from 'react'
import { selectedInOrder, useQueue } from '../store/queue'
import { EmptyState } from './EmptyState'
import { JOB_DRAG_TYPE, JobRow, ROW_GAP, ROW_HEIGHT } from './JobRow'

const PADDING = 12
const STRIDE = ROW_HEIGHT + ROW_GAP
const FOCUS_KEYS: Record<string, number | 'first' | 'last'> = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' }

interface Band {
  x: number
  y: number
  width: number
  height: number
}

/** Index of the row under a vertical offset measured from the top of the list content. */
function rowAt(offset: number): number {
  return Math.floor((offset - PADDING) / STRIDE)
}

export function JobList() {
  const order = useQueue((state) => state.order)
  const focus = useQueue((state) => state.focus)
  const scroller = useRef<HTMLDivElement>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [band, setBand] = useState<Band | null>(null)
  const focusIndex = focus ? order.indexOf(focus) : -1
  // The listbox names the focused row as its active descendant, so that row stays rendered even when scrolled away.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range)
      return focusIndex < 0 || indexes.includes(focusIndex) ? indexes : [...indexes, focusIndex].sort((a, b) => a - b)
    },
    [focusIndex]
  )

  // Only the rows in view are rendered; every row has the same height.
  const virtualizer = useVirtualizer({
    count: order.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => STRIDE,
    paddingStart: PADDING,
    paddingEnd: PADDING - ROW_GAP,
    scrollPaddingStart: PADDING,
    scrollPaddingEnd: PADDING,
    overscan: 6,
    getItemKey: (index) => order[index] ?? index,
    rangeExtractor
  })

  // Keep the keyboard focus in view.
  useEffect(() => {
    const index = focus ? useQueue.getState().order.indexOf(focus) : -1
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' })
  }, [focus, virtualizer])

  const contentOffset = (clientY: number): number => {
    const element = scroller.current as HTMLDivElement
    return clientY - element.getBoundingClientRect().top + element.scrollTop
  }

  const onDragStartRow = useCallback((event: DragEvent<HTMLDivElement>, id: string) => {
    const state = useQueue.getState()
    const ids = state.selected.has(id) ? selectedInOrder(state) : [id]
    if (!state.selected.has(id)) state.select(id)
    event.dataTransfer.setData(JOB_DRAG_TYPE, JSON.stringify(ids))
    event.dataTransfer.effectAllowed = 'move'
  }, [])

  const onDragOver = (event: DragEvent): void => {
    if (!event.dataTransfer.types.includes(JOB_DRAG_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const offset = contentOffset(event.clientY) - PADDING + ROW_GAP / 2
    setDropIndex(Math.min(Math.max(Math.round(offset / STRIDE), 0), order.length))
  }

  const onDrop = (event: DragEvent): void => {
    const data = event.dataTransfer.getData(JOB_DRAG_TYPE)
    if (!data || dropIndex === null) return
    event.preventDefault()
    useQueue.getState().move(JSON.parse(data) as string[], dropIndex)
    setDropIndex(null)
  }

  /** Drag on empty space to select every row the rectangle touches. */
  const onMouseDown = (event: MouseEvent): void => {
    const element = scroller.current as HTMLDivElement
    const rect = element.getBoundingClientRect()
    // Presses on the scrollbar arrive here too; leave the selection alone.
    if (event.button !== 0 || event.clientX - rect.left >= element.clientWidth) return
    if ((event.target as HTMLElement).closest('[role="option"]')) return
    element.focus()
    const additive = event.shiftKey || event.ctrlKey || event.metaKey
    const initial = additive ? selectedInOrder(useQueue.getState()) : []
    if (!additive) useQueue.getState().clearSelection()
    const startX = event.clientX - rect.left
    const startY = contentOffset(event.clientY)

    const move = (e: globalThis.MouseEvent): void => {
      const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width)
      const y = Math.max(contentOffset(e.clientY), 0)
      const top = Math.min(startY, y)
      const bottom = Math.max(startY, y)
      setBand({ x: Math.min(startX, x), y: top, width: Math.abs(x - startX), height: bottom - top })
      const state = useQueue.getState()
      const first = Math.max(rowAt(top), 0)
      const last = Math.min(rowAt(bottom), state.order.length - 1)
      const hit: string[] = []
      for (let i = first; i <= last; i += 1) {
        const rowTop = PADDING + i * STRIDE
        if (rowTop < bottom && rowTop + ROW_HEIGHT > top) hit.push(state.order[i] as string)
      }
      const lead = hit[0] ?? state.focus
      state.setSelection([...new Set([...initial, ...hit])], hit[0] ?? state.anchor, lead)
    }
    const up = (): void => {
      setBand(null)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return
    const state = useQueue.getState()
    if (event.key === ' ') {
      if (!state.focus) return
      event.preventDefault()
      state.select(state.focus, { toggle: true })
      return
    }
    const to = FOCUS_KEYS[event.key]
    if (to === undefined) return
    event.preventDefault()
    state.moveFocus(to, event.shiftKey)
  }

  if (order.length === 0) return <EmptyState />

  return (
    <div
      ref={scroller}
      role="listbox"
      aria-label="Queue"
      aria-multiselectable
      aria-activedescendant={focus ? `job-${focus}` : undefined}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropIndex(null)
      }}
      onDrop={onDrop}
      onDragEnd={() => setDropIndex(null)}
      className="group/list @container relative min-h-0 flex-1 overflow-y-auto outline-none"
      style={{ paddingInline: PADDING }}
    >
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div key={item.key} className="absolute inset-x-0 top-0" style={{ transform: `translateY(${item.start}px)` }}>
            <JobRow id={order[item.index] as string} position={item.index + 1} total={order.length} onDragStartRow={onDragStartRow} />
          </div>
        ))}
      </div>
      {dropIndex !== null && (
        <div
          className="pointer-events-none absolute inset-x-3 z-10 h-0.5 rounded-full bg-accent shadow-[0_0_0_2px] shadow-accent/25"
          style={{ top: PADDING + dropIndex * STRIDE - ROW_GAP / 2 - 1 }}
        />
      )}
      {band && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-accent/70 bg-accent/12"
          style={{ left: band.x, top: band.y, width: band.width, height: band.height }}
        />
      )}
    </div>
  )
}
