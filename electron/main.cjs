const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "DiscCompressor Pro",
    icon: path.join(__dirname, '../build/icon.png'),
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
const activeProcesses = new Map();

ipcMain.handle('cancel-job', (event, jobId) => {
  const child = activeProcesses.get(jobId);
  if (child) {
    child.kill();
    activeProcesses.delete(jobId);
    return true;
  }
  return false;
});

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
  else if (type === 'Extract') {
    outputExt = settings.extractFormat === 'BIN/CUE' ? '.cue' : '.iso';
  }
  
  let outputPath = (type === 'Info' || type === 'Verify') ? null : path.join(outputDir, `${baseName}${outputExt}`);
  
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
    if (settings.threads) {
      args.push('--numprocessors', settings.threads.toString());
    }
  } else if (type === 'Extract') {
    if (ext.toLowerCase() === '.chd') {
      cmd = 'chdman';
      let extractCmd = settings.extractFormat === 'BIN/CUE' ? 'extractcd' : 'extractdvd';
      let finalOutputExt = settings.extractFormat === 'BIN/CUE' ? '.cue' : '.iso';

      try {
        const { stdout } = await execPromise(`chdman info -i "${inputPath}"`);
        if (stdout.includes("Tag='DVD '")) {
          extractCmd = 'extractdvd';
          finalOutputExt = '.iso';
        } else if (stdout.includes("TRACK:1") || stdout.includes("Tag='CHCD'")) {
          extractCmd = 'extractcd';
          finalOutputExt = '.cue';
        }
      } catch (e) {
        console.error("Failed to get chd info", e);
      }

      outputPath = path.join(outputDir, `${baseName}${finalOutputExt}`);
      args = [extractCmd, '-i', inputPath, '-o', outputPath, '-f'];
    } else {
      cmd = 'maxcso';
      args = ['--decompress', inputPath, '-o', outputPath];
      if (settings.threads) args.push('--threads=' + settings.threads);
    }
  } else if (type === 'Info') {
    cmd = 'chdman';
    args = ['info', '-i', inputPath];
  } else if (type === 'Verify') {
    cmd = 'chdman';
    args = ['verify', '-i', inputPath];
  } else {
    // Assume maxcso for CSO/ZSO
    cmd = 'maxcso';
    args = [`--block=2048`];
    if (type === 'ZSO') args.push('--format=zso');
    if (type === 'JSO') args.push('--format=jso');
    if (type === 'DAX') args.push('--format=dax');
    if (settings.threads) args.push('--threads=' + settings.threads);
    args.push(inputPath, '-o', outputPath);
  }

  const sendEvent = (type, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`job-event-${jobId}`, { type, data });
    }
  };

  sendEvent('log', { level: 'info', message: `Executing: ${cmd} ${args.join(' ')}` });

  const child = spawn(cmd, args);
  activeProcesses.set(jobId, child);
  
  const handleOutput = (data, isError) => {
    const msg = data.toString().trim();
    if (!msg) return;
    
    sendEvent('log', { level: isError ? 'warn' : 'info', message: msg });
    
    if (msg.includes('%')) {
      const match = msg.match(/(\d+(?:\.\d+)?)%/);
      if (match) {
        sendEvent('progress', { progress: parseFloat(match[1]) });
      }
    }
  };

  child.stdout.on('data', (data) => handleOutput(data, false));
  child.stderr.on('data', (data) => handleOutput(data, true));
  
  child.on('error', (err) => {
    sendEvent('log', { level: 'error', message: `Failed to start ${cmd}: ${err.message}` });
    sendEvent('log', { level: 'error', message: `Make sure '${cmd}' is installed and in your PATH.` });
    sendEvent('error', { message: err.message });
  });
  
  child.on('close', (code, signal) => {
    activeProcesses.delete(jobId);
    if (code === 0) {
      sendEvent('log', { level: 'info', message: `Successfully finished ${outputPath || 'operation'}` });
      sendEvent('complete', { outputPath });
    } else if (code === null || signal === 'SIGTERM') {
      sendEvent('log', { level: 'warn', message: `Process was cancelled` });
      sendEvent('error', { message: `Cancelled` });
    } else {
      sendEvent('log', { level: 'error', message: `Process exited with code ${code}` });
      sendEvent('error', { message: `Process exited with code ${code}` });
    }
  });

  return { status: 'started' };
});
