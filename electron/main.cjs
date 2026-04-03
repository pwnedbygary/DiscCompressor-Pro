const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    title: "DiscCompressor Pro",
    webPreferences: {
      nodeIntegration: true
    }
  });

  win.loadURL('http://localhost:3000');
}

app.whenReady().then(() => {
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
