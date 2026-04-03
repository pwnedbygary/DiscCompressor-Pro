const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
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

  // Remove native menu
  Menu.setApplicationMenu(null);

  win.loadURL('http://localhost:3000');
}

// IPC handler for directory selection
ipcMain.handle('dialog:openDirectory', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  if (canceled) {
    return null;
  } else {
    return filePaths[0];
  }
});

// IPC handler to quit app
ipcMain.on('quit-app', () => {
  app.quit();
});

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
