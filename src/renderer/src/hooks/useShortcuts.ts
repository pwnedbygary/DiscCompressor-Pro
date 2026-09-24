import { useEffect } from 'react'
import { pickAndAdd } from '../actions'
import { removeJobs, startQueue, stopQueue } from '../store/scheduler'
import { selectedInOrder, useQueue } from '../store/queue'
import { useUi } from '../store/ui'

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return !!element && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName))
}

/** The typed Latin letter, or the physical letter key on layouts without Latin letters (Cyrillic, Greek, …). */
function shortcutKey(event: KeyboardEvent): string {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  if (/^[a-z]$/.test(key) || !/^Key[A-Z]$/.test(event.code)) return key
  return event.code.slice(3).toLowerCase()
}

export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (document.querySelector('dialog[open], :popover-open')) return
      const mod = event.ctrlKey || event.metaKey
      const key = shortcutKey(event)
      const nudge = event.altKey && (key === 'ArrowUp' || key === 'ArrowDown')
      if (event.repeat && !nudge) return
      const ui = useUi.getState()

      if (key === 'F1') {
        event.preventDefault()
        ui.setHelpOpen(true)
        return
      }
      if (mod && key === ',') {
        event.preventDefault()
        ui.setSettingsOpen(true)
        return
      }
      if (mod && key === 'o') {
        event.preventDefault()
        void pickAndAdd(event.shiftKey ? 'folder' : 'files')
        return
      }
      if (mod && key === 'Enter') {
        event.preventDefault()
        startQueue()
        return
      }
      if (mod && key === '.') {
        event.preventDefault()
        stopQueue()
        return
      }
      if (mod && key === 'l') {
        event.preventDefault()
        ui.setLogOpen(!ui.logOpen)
        return
      }
      if (mod && key === 'i') {
        event.preventDefault()
        ui.setInspectorOpen(!ui.inspectorOpen)
        return
      }

      if (isTyping(event.target)) return
      const queue = useQueue.getState()
      const selected = selectedInOrder(queue)

      if (mod && key === 'a') {
        event.preventDefault()
        queue.selectAll()
      } else if (mod && key === 'd' && selected.length > 0) {
        event.preventDefault()
        queue.duplicate(selected)
      } else if ((key === 'Delete' || (key === 'Backspace' && mod)) && selected.length > 0) {
        event.preventDefault()
        removeJobs(selected)
      } else if (nudge && selected.length > 0) {
        event.preventDefault()
        queue.nudge(selected, key === 'ArrowUp' ? -1 : 1)
      } else if (key === 'Escape' && selected.length > 0) {
        queue.clearSelection()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
