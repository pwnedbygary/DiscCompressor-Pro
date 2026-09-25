import { useEffect, useState } from 'react'
import { addPaths } from '../actions'
import { api } from '../lib/api'

function hasFiles(event: DragEvent): boolean {
  return !!event.dataTransfer && event.dataTransfer.types.includes('Files')
}

/** Accept files and folders dropped anywhere on the window. Returns whether a drag is over it. */
export function useFileDrop(): boolean {
  const [active, setActive] = useState(false)

  useEffect(() => {
    let depth = 0
    const onDragEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth += 1
      setActive(true)
    }
    const onDragOver = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setActive(false)
    }
    const onDrop = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      setActive(false)
      const paths = [...(event.dataTransfer?.files ?? [])].map((file) => api.pathForFile(file)).filter(Boolean)
      void addPaths(paths)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return active
}
