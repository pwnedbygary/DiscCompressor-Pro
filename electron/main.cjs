const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
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

  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
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
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- Settings Management ---
const userDataPath = app.getPath('userData');
const settingsPath = path.join(userDataPath, 'settings.json');

let appSettings = {
  outputDirectory: path.join(os.homedir(), 'DiscCompressorPro_Outputs'),
  defaultFormat: 'CHD',
  themeId: 'adwaita'
};

if (fs.existsSync(settingsPath)) {
  try {
    appSettings = { ...appSettings, ...JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) };
  } catch (e) {
    console.error('Failed to load settings', e);
  }
}

ipcMain.handle('get-settings', () => {
  return appSettings;
});

ipcMain.handle('save-settings', (event, newSettings) => {
  appSettings = { ...appSettings, ...newSettings };
  fs.writeFileSync(settingsPath, JSON.stringify(appSettings, null, 2));
  return { success: true };
});

// --- Processing Logic ---
ipcMain.handle('process-file', async (event, { jobId, fileName, type, settings, inputPath }) => {
  if (!inputPath) {
    throw new Error('inputPath is required');
  }

  const outputDir = appSettings.outputDirectory;
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const ext = path.extname(fileName);
  const baseName = path.basename(fileName, ext);
  
  let outputExt = '.chd';
  if (type === 'CSO' || type === 'CSOv2') outputExt = '.cso';
  else if (type === 'ZSO') outputExt = '.zso';
  else if (type === 'JSO') outputExt = '.jso';
  else if (type === 'DAX') outputExt = '.dax';
  
  const outputPath = path.join(outputDir, `${baseName}${outputExt}`);
  
  let cmd = '';
  let args = [];
  
  if (type === 'CHD') {
    cmd = 'chdman';
    const createCmd = ext.toLowerCase() === '.iso' ? 'createdvd' : 'createcd';
    args = [createCmd, '-i', inputPath, '-o', outputPath, '-f'];
    if (settings.hunkSize) {
      args.push('-hs', settings.hunkSize.toString());
    }
    if (settings.chdAlgorithms && settings.chdAlgorithms.length > 0) {
      args.push('-c', settings.chdAlgorithms.join(','));
    }
  } else {
    // Assume maxcso for CSO/ZSO
    cmd = 'maxcso';
    args = [`--block=2048`];
    if (type === 'ZSO') args.push('--format=zso');
    if (type === 'JSO') args.push('--format=jso');
    if (type === 'DAX') args.push('--format=dax');
    args.push(inputPath, '-o', outputPath);
  }

  const sendEvent = (type, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`job-event-${jobId}`, { type, data });
    }
  };

  sendEvent('log', { level: 'info', message: `Executing: ${cmd} ${args.join(' ')}` });

  const child = spawn(cmd, args);
  
  child.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) sendEvent('log', { level: 'info', message: msg });
    
    if (msg.includes('%')) {
      const match = msg.match(/(\d+(?:\.\d+)?)%/);
      if (match) {
        sendEvent('progress', { progress: parseFloat(match[1]) });
      }
    }
  });
  
  child.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) sendEvent('log', { level: 'warn', message: msg });
  });
  
  child.on('error', (err) => {
    sendEvent('log', { level: 'error', message: `Failed to start ${cmd}: ${err.message}` });
    sendEvent('log', { level: 'error', message: `Make sure '${cmd}' is installed and in your PATH.` });
    sendEvent('error', { message: err.message });
  });
  
  child.on('close', (code) => {
    if (code === 0) {
      sendEvent('log', { level: 'info', message: `Successfully created ${outputPath}` });
      sendEvent('complete', { outputPath });
    } else {
      sendEvent('log', { level: 'error', message: `Process exited with code ${code}` });
      sendEvent('error', { message: `Process exited with code ${code}` });
    }
  });

  return { status: 'started' };
});
