const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "DiscCompressor Pro",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const template = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Settings',
          click: () => {
            win.webContents.send('open-settings');
          }
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  win.loadURL('http://localhost:3000');
}

app.whenReady().then(() => {
  // Pass user data path to the server
  process.env.USER_DATA_PATH = app.getPath('userData');
  
  const isDev = !app.isPackaged;
  
  if (isDev) {
    createWindow();
  } else {
    // In production, run the server directly in the main process
    process.env.NODE_ENV = 'production';
    const serverPath = path.join(__dirname, '..', 'server.cjs');
    
    try {
      require(serverPath);
      // Wait a second for Express to start
      setTimeout(createWindow, 1000);
    } catch (err) {
      console.error('Failed to start server:', err);
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
