const { app, BrowserWindow, Menu, ipcMain, dialog, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

let mainWindow;
let tray = null;

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

function getIconPath() {
  const pngPath = path.join(__dirname, '../assets/tray-icon-64.png');
  const fallbackPath = path.join(__dirname, '../assets/tray-icon.png');
  if (fs.existsSync(pngPath)) return pngPath;
  if (fs.existsSync(fallbackPath)) return fallbackPath;
  return undefined;
}

function getPhysicalIconPath() {
  const asarIconPath = getIconPath();
  if (!asarIconPath) return undefined;
  
  try {
    // Write to userData instead of temp, as some Linux environments restrict AppIndicator from reading /tmp
    const userDataPath = app.getPath('userData');
    const physicalPath = path.join(userDataPath, 'disccompressor-tray-icon.png');
    const iconBuffer = fs.readFileSync(asarIconPath);
    fs.writeFileSync(physicalPath, iconBuffer);
    console.log('Wrote physical icon to:', physicalPath);
    return physicalPath;
  } catch (e) {
    console.error('Failed to write physical icon:', e);
    return asarIconPath;
  }
}

function createWindow() {
  const iconPath = getPhysicalIconPath();
  const windowOptions = {
    width: 1200,
    height: 800,
    title: "DiscCompressor Pro",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  };
  if (iconPath) windowOptions.icon = iconPath;

  mainWindow = new BrowserWindow(windowOptions);

  // Remove native menu
  Menu.setApplicationMenu(null);

  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('minimize', (event) => {
    if (appSettings.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuiting && appSettings.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });
}

// Removed getTrayIconPath

function createTray() {
  const physicalIconPath = getPhysicalIconPath();
  if (!physicalIconPath) {
    console.error('No physical tray icon path found!');
    return;
  }
  
  try {
    console.log('Creating tray with physical path string:', physicalIconPath);
    // PASS THE STRING DIRECTLY. Do NOT use nativeImage.
    // This forces GTK/AppIndicator to load the file directly from disk,
    // bypassing Electron's Chromium image decoder which is failing in this AppImage.
    tray = new Tray(physicalIconPath);
  } catch (e) {
    console.error('Failed to create tray with string path:', e);
    // Fallback to nativeImage just in case
    tray = new Tray(nativeImage.createFromPath(physicalIconPath));
  }

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => {
        if (mainWindow) {
          mainWindow.show();
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
        }
      } 
    },
    { label: 'Quit', click: () => {
        app.isQuiting = true;
        app.quit();
      }
    }
  ]);
  tray.setToolTip('DiscCompressor Pro');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
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

// --- Settings Management ---
const userDataPath = app.getPath('userData');
const settingsPath = path.join(userDataPath, 'settings.json');

let appSettings = {
  outputDirectory: path.join(os.homedir(), 'DiscCompressorPro_Outputs'),
  defaultFormat: 'CHD',
  themeId: 'adwaita',
  deleteOriginals: false,
  autoGenerateM3U: false,
  minimizeToTray: false
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

ipcMain.handle('get-real-file-size', async (event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return 0;
  
  let totalSize = 0;
  try {
    const stats = fs.statSync(filePath);
    totalSize += stats.size;

    if (filePath.toLowerCase().endsWith('.cue')) {
      const cueContent = fs.readFileSync(filePath, 'utf8');
      const binMatches = cueContent.match(/FILE\s+"([^"]+)"/g);
      if (binMatches) {
        binMatches.forEach(match => {
          const binFile = match.match(/FILE\s+"([^"]+)"/)[1];
          const binPath = path.join(path.dirname(filePath), binFile);
          if (fs.existsSync(binPath)) {
            totalSize += fs.statSync(binPath).size;
          }
        });
      }
    } else if (filePath.toLowerCase().endsWith('.gdi')) {
      const gdiContent = fs.readFileSync(filePath, 'utf8');
      const lines = gdiContent.split('\n');
      lines.forEach(line => {
        const parts = line.trim().split(/\s+/);
        // A typical GDI track line has at least 6 parts: track, lba, type, sector_size, filename, offset
        if (parts.length >= 6 && !isNaN(parseInt(parts[0]))) {
          // The filename is usually the 5th part (index 4)
          // But if it has spaces, it might be quoted. Let's handle basic unquoted first,
          // or just match .bin/.raw
          const filenameMatch = line.match(/"([^"]+)"/) || line.match(/([^\s]+\.(?:bin|raw|iso))/i);
          if (filenameMatch) {
            const binFile = filenameMatch[1];
            const binPath = path.join(path.dirname(filePath), binFile);
            if (fs.existsSync(binPath)) {
              totalSize += fs.statSync(binPath).size;
            }
          }
        }
      });
    }
  } catch (e) {
    console.error('Failed to get real file size', e);
  }
  return totalSize;
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
    if (settings.extractFormat === 'BIN/CUE') outputExt = '.cue';
    else if (settings.extractFormat === 'GDI') outputExt = '.gdi';
    else outputExt = '.iso';
  }
  
  let outputPath = (type === 'Info' || type === 'Verify') ? null : path.join(outputDir, `${baseName}${outputExt}`);
  
  let cmd = '';
  let args = [];
  
  const sendEvent = (type, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`job-event-${jobId}`, { type, data });
    }
  };

  let tempFilesToDelete = [];
  let actualInputPath = inputPath;
  const extLower = ext.toLowerCase();

  try {
    if (type === 'CHD' && ['.cso', '.zso', '.csov2', '.dax', '.jso'].includes(extLower)) {
      sendEvent('log', { level: 'info', message: `Decompressing ${extLower} to temporary ISO...` });
      const tempIsoPath = path.join(outputDir, `${baseName}_temp.iso`);
      await new Promise((resolve, reject) => {
        const p = spawn('maxcso', ['--decompress', inputPath, '-o', tempIsoPath]);
        p.on('close', code => {
          if (code === 0) resolve();
          else reject(new Error(`Failed to decompress ${extLower}`));
        });
      });
      actualInputPath = tempIsoPath;
      tempFilesToDelete.push(tempIsoPath);
    } else if (['CSO', 'CSOv2', 'ZSO'].includes(type)) {
      if (extLower === '.chd') {
        sendEvent('log', { level: 'info', message: `Decompressing CHD to temporary ISO...` });
        const tempIsoPath = path.join(outputDir, `${baseName}_temp.iso`);
        await new Promise((resolve, reject) => {
          const p = spawn('chdman', ['extractdvd', '-i', inputPath, '-o', tempIsoPath, '-f']);
          p.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`Failed to decompress CHD`));
          });
        });
        actualInputPath = tempIsoPath;
        tempFilesToDelete.push(tempIsoPath);
      } else if (['.cso', '.zso', '.csov2', '.dax', '.jso'].includes(extLower) && extLower !== outputExt) {
        sendEvent('log', { level: 'info', message: `Decompressing ${extLower} to temporary ISO...` });
        const tempIsoPath = path.join(outputDir, `${baseName}_temp.iso`);
        await new Promise((resolve, reject) => {
          const p = spawn('maxcso', ['--decompress', inputPath, '-o', tempIsoPath]);
          p.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`Failed to decompress ${extLower}`));
          });
        });
        actualInputPath = tempIsoPath;
        tempFilesToDelete.push(tempIsoPath);
      }
    }
  } catch (e) {
    sendEvent('error', { message: e.message });
    return;
  }
  
  if (type === 'CHD') {
    cmd = 'chdman';
    const createCmd = path.extname(actualInputPath).toLowerCase() === '.iso' ? 'createdvd' : 'createcd';
    args = [createCmd, '-i', actualInputPath, '-o', outputPath, '-f'];
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
    if (extLower === '.chd') {
      cmd = 'chdman';
      let extractCmd = 'extractdvd';
      let finalOutputExt = '.iso';
      if (settings.extractFormat === 'BIN/CUE') {
        extractCmd = 'extractcd';
        finalOutputExt = '.cue';
      } else if (settings.extractFormat === 'GDI') {
        extractCmd = 'extractcd';
        finalOutputExt = '.gdi';
      }

      try {
        const { stdout } = await execPromise(`chdman info -i "${actualInputPath}"`);
        if (stdout.includes("Tag='DVD '")) {
          if (settings.extractFormat === 'GDI' || settings.extractFormat === 'BIN/CUE') {
            sendEvent('log', { level: 'warn', message: `Warning: ${settings.extractFormat} is not valid for DVD CHDs. Extracting to ISO instead.` });
          }
          extractCmd = 'extractdvd';
          finalOutputExt = '.iso';
        } else if (stdout.includes("Tag='CHGD'") || stdout.includes("Tag='CHGT'")) {
          if (settings.extractFormat === 'BIN/CUE') {
            throw new Error("Cannot extract GDI CHD to BIN/CUE format. Please select GDI extraction format.");
          }
          extractCmd = 'extractcd';
          finalOutputExt = '.gdi';
        } else if (stdout.includes("Tag='CHT2'") || stdout.includes("Tag='CHTR'") || stdout.includes("Tag='CHCD'") || stdout.includes("TRACK:1")) {
          if (settings.extractFormat === 'GDI') {
            throw new Error("Cannot extract standard CD CHD to GDI format. Please select BIN/CUE extraction format.");
          }
          extractCmd = 'extractcd';
          finalOutputExt = '.cue';
        }
      } catch (e) {
        if (e.message.includes('Cannot extract')) {
          throw e; // Rethrow validation errors to fail the job
        }
        console.error("Failed to get chd info", e);
      }

      outputPath = path.join(outputDir, `${baseName}${finalOutputExt}`);
      args = [extractCmd, '-i', actualInputPath, '-o', outputPath, '-f'];
    } else {
      cmd = 'maxcso';
      args = ['--decompress', actualInputPath, '-o', outputPath];
      if (settings.threads) args.push('--threads=' + settings.threads);
    }
  } else if (type === 'Info') {
    cmd = 'chdman';
    args = ['info', '-i', actualInputPath];
  } else if (type === 'Verify') {
    cmd = 'chdman';
    args = ['verify', '-i', actualInputPath];
  } else {
    // Assume maxcso for CSO/ZSO
    cmd = 'maxcso';
    args = [`--block=2048`];
    if (type === 'CSOv2') args.push('--format=cso2');
    if (type === 'ZSO') args.push('--format=zso');
    if (type === 'JSO') args.push('--format=jso');
    if (type === 'DAX') args.push('--format=dax');
    if (settings.threads) args.push('--threads=' + settings.threads);
    if (settings.maxcsoAlgorithms && settings.maxcsoAlgorithms.length > 0) {
      settings.maxcsoAlgorithms.forEach(algo => {
        if (algo !== 'fast') {
          args.push(`--${algo}`);
        } else {
          args.push('--fast');
        }
      });
    }
    args.push(actualInputPath, '-o', outputPath);
  }

  sendEvent('log', { level: 'info', message: `Executing: ${cmd} ${args.join(' ')}` });

  const child = spawn(cmd, args);
  activeProcesses.set(jobId, child);
  
  let stdoutBuffer = '';
  let stderrBuffer = '';

  const processBuffer = (buffer, isError) => {
    let lines = buffer.split(/[\r\n]+/);
    // Keep the last part in the buffer if it doesn't end with a newline/carriage return
    // Actually, chdman uses \r for progress updates, so we should process all parts
    // except the last one if it's incomplete. But \r means the line is "complete" for progress.
    // Let's just split by \r or \n and process all non-empty parts.
    // Wait, if a chunk ends in the middle of a word, we shouldn't split it.
    // A better approach:
    
    // We'll just split by \r or \n. The last element is the incomplete line.
    const incomplete = lines.pop();
    
    for (const line of lines) {
      const msg = line.trim();
      if (!msg) continue;
      
      sendEvent('log', { level: isError ? 'warn' : 'info', message: msg });
      
      if (msg.includes('%')) {
        const match = msg.match(/(\d+(?:\.\d+)?)%/);
        if (match) {
          sendEvent('progress', { progress: parseFloat(match[1]) });
        }
      }
    }
    return incomplete;
  };

  child.stdout.on('data', (data) => {
    stdoutBuffer += data.toString();
    stdoutBuffer = processBuffer(stdoutBuffer, false);
  });
  
  child.stderr.on('data', (data) => {
    stderrBuffer += data.toString();
    stderrBuffer = processBuffer(stderrBuffer, true);
  });
  
  child.on('error', (err) => {
    // Clean up temporary files
    tempFilesToDelete.forEach(f => {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch (e) {
        console.error('Failed to delete temp file', e);
      }
    });

    sendEvent('log', { level: 'error', message: `Failed to start ${cmd}: ${err.message}` });
    sendEvent('log', { level: 'error', message: `Make sure '${cmd}' is installed and in your PATH.` });
    sendEvent('error', { message: err.message });
  });
  
  child.on('close', (code, signal) => {
    activeProcesses.delete(jobId);
    
    // Process any remaining buffer
    if (stdoutBuffer.trim()) {
      sendEvent('log', { level: 'info', message: stdoutBuffer.trim() });
    }
    if (stderrBuffer.trim()) {
      sendEvent('log', { level: 'warn', message: stderrBuffer.trim() });
    }
    
    // Clean up temporary files
    tempFilesToDelete.forEach(f => {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch (e) {
        console.error('Failed to delete temp file', e);
      }
    });

    if (code === 0) {
      sendEvent('log', { level: 'info', message: `Successfully finished ${outputPath || 'operation'}` });
      
      // Auto M3U Generation
      if (appSettings.autoGenerateM3U && outputPath) {
        try {
          const outExt = path.extname(outputPath);
          const outBase = path.basename(outputPath, outExt);
          const outDir = path.dirname(outputPath);
          const match = outBase.match(/^(.*?)\s*[\[\(]Dis[ck]\s*\d+[\]\)]$/i);
          if (match) {
            const gameName = match[1];
            const m3uPath = path.join(outDir, `${gameName}.m3u`);
            const files = fs.readdirSync(outDir);
            const discFiles = files.filter(f => {
              const fExt = path.extname(f);
              const fBase = path.basename(f, fExt);
              const fMatch = fBase.match(/^(.*?)\s*[\[\(]Dis[ck]\s*\d+[\]\)]$/i);
              return fExt === outExt && fMatch && fMatch[1] === gameName;
            });
            discFiles.sort();
            fs.writeFileSync(m3uPath, discFiles.join('\n'));
            sendEvent('log', { level: 'success', message: `Generated playlist: ${gameName}.m3u` });
          }
        } catch (e) {
          console.error('Failed to generate M3U', e);
        }
      }

      // Delete Originals
      if (appSettings.deleteOriginals && inputPath && fs.existsSync(inputPath)) {
        try {
          let filesToDelete = [inputPath];
          if (inputPath.toLowerCase().endsWith('.cue')) {
            const cueContent = fs.readFileSync(inputPath, 'utf8');
            const binMatches = cueContent.match(/FILE\s+"([^"]+)"/g);
            if (binMatches) {
              binMatches.forEach(match => {
                const binFile = match.match(/FILE\s+"([^"]+)"/)[1];
                filesToDelete.push(path.join(path.dirname(inputPath), binFile));
              });
            }
          } else if (inputPath.toLowerCase().endsWith('.gdi')) {
            const gdiContent = fs.readFileSync(inputPath, 'utf8');
            const lines = gdiContent.split('\n');
            lines.forEach(line => {
              const parts = line.trim().split(/\s+/);
              if (parts.length >= 6 && !isNaN(parseInt(parts[0]))) {
                const filenameMatch = line.match(/"([^"]+)"/) || line.match(/([^\s]+\.(?:bin|raw|iso))/i);
                if (filenameMatch) {
                  const binFile = filenameMatch[1];
                  filesToDelete.push(path.join(path.dirname(inputPath), binFile));
                }
              }
            });
          }
          filesToDelete.forEach(f => {
            if (fs.existsSync(f)) fs.unlinkSync(f);
          });
          sendEvent('log', { level: 'success', message: `Deleted original files` });
        } catch (e) {
          console.error('Failed to delete original files', e);
        }
      }

      // Get final file size
      let finalSize = 0;
      if (outputPath && fs.existsSync(outputPath)) {
        finalSize = fs.statSync(outputPath).size;
      }

      sendEvent('complete', { outputPath, finalSize });
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
