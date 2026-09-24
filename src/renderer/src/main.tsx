import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SYSTEM_THEME_ID } from '@shared/themes'
import { App } from './App'
import { Button } from './components/ui/Button'
import { errorMessage } from './lib/errors'
import { watchTheme } from './lib/theme'
import { useSettings } from './store/settings'
import './styles/index.css'

function StartupError({ message }: { message: string }) {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-base font-semibold">DiscCompressor Pro could not start</h1>
        <p className="text-xs break-words text-muted" data-selectable>
          {message}
        </p>
        <Button variant="primary" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </div>
    </div>
  )
}

async function start(): Promise<void> {
  const root = createRoot(document.getElementById('root') as HTMLElement)
  try {
    await useSettings.getState().load()
  } catch (error) {
    watchTheme(() => SYSTEM_THEME_ID)
    root.render(<StartupError message={errorMessage(error)} />)
    return
  }

  const themeId = (): string => useSettings.getState().settings?.themeId ?? SYSTEM_THEME_ID
  let applied = themeId()
  const refreshTheme = watchTheme(themeId)
  useSettings.subscribe(() => {
    if (themeId() !== applied) {
      applied = themeId()
      refreshTheme()
    }
  })

  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void start()
