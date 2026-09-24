import { Menu, Tray, nativeImage } from 'electron'
import type { AppCommand } from '@shared/types'
import { iconPath } from './paths'

export interface TrayActions {
  show: () => void
  command: (command: AppCommand) => void
  quit: () => void
}

export function createTray(actions: TrayActions): Tray | null {
  const image = nativeImage.createFromPath(iconPath(process.platform === 'win32' ? 'icon.ico' : 'tray.png'))
  if (image.isEmpty()) {
    console.error('Tray icon could not be loaded; the tray is disabled.')
    return null
  }
  let tray: Tray
  try {
    tray = new Tray(image)
  } catch (error) {
    console.error('The system tray is unavailable.', error)
    return null
  }
  tray.setToolTip('DiscCompressor Pro')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show DiscCompressor Pro', click: actions.show },
      { type: 'separator' },
      { label: 'Start queue', click: () => actions.command('start-queue') },
      { label: 'Stop queue', click: () => actions.command('stop-queue') },
      { type: 'separator' },
      {
        label: 'Settings…',
        click: () => {
          actions.show()
          actions.command('open-settings')
        }
      },
      { label: 'Quit', click: actions.quit }
    ])
  )
  tray.on('click', actions.show)
  return tray
}
