const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let serverProcess;

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
    // In production, start the packaged server
    const serverPath = path.join(__dirname, '..', 'server.js');
    
    // Set NODE_ENV to production so the server serves static files
    const env = Object.create(process.env);
    env.NODE_ENV = 'production';
    
    serverProcess = spawn('node', [serverPath], { env, stdio: 'inherit' });
    
    // Wait a second for Express to start
    setTimeout(createWindow, 1000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
  if (serverProcess) serverProcess.kill();
});
