import { FolderPlus, Plus } from 'lucide-react'
import { pickAndAdd } from '../actions'
import iconUrl from '../assets/icon.png'
import { Button } from './ui/Button'

const FORMATS = ['BIN/CUE', 'GDI', 'CDI', 'ISO', 'CHD', 'CSO', 'ZSO', 'DAX']

export function EmptyState() {
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-8">
      <div className="flex max-w-md flex-col items-center text-center">
        <div className="relative mb-6">
          <div className="absolute inset-0 scale-125 rounded-full bg-accent/15 blur-2xl" />
          <img src={iconUrl} alt="" className="relative size-24 drop-shadow-xl" draggable={false} />
        </div>
        <h2 className="text-lg font-semibold tracking-tight">Drop disc images here</h2>
        <p className="mt-1.5 text-[13px] text-muted">
          Compress to CHD, CSO or ZSO, extract back to BIN/CUE, GDI, ISO or CDI, and verify CHDs. Folders are searched for images automatically.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-1.5">
          {FORMATS.map((format) => (
            <span key={format} className="rounded-md border border-line bg-elevated px-2 py-0.5 font-mono text-2xs text-muted">
              {format}
            </span>
          ))}
        </div>
        <div className="mt-6 flex gap-2">
          <Button variant="primary" icon={Plus} onClick={() => void pickAndAdd('files')}>
            Add files
          </Button>
          <Button icon={FolderPlus} onClick={() => void pickAndAdd('folder')}>
            Add folder
          </Button>
        </div>
      </div>
    </div>
  )
}
