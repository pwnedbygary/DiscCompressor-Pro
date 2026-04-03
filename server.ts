import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const uploadDir = path.join(process.cwd(), 'uploads');
const outputDir = path.join(process.cwd(), 'outputs');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const upload = multer({ storage });

// Store SSE clients
const clients = new Map<string, express.Response>();

function sendEvent(jobId: string, type: string, data: any) {
  const res = clients.get(jobId);
  if (res) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

// API Routes
app.post('/api/upload', upload.array('files'), (req, res) => {
  res.json({ message: 'Files uploaded successfully' });
});

app.get('/api/events/:jobId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const jobId = req.params.jobId;
  clients.set(jobId, res);
  
  req.on('close', () => {
    clients.delete(jobId);
  });
});

app.post('/api/process', (req, res) => {
  const { jobId, fileName, type, settings } = req.body;
  
  const inputPath = path.join(uploadDir, fileName);
  const ext = path.extname(fileName);
  const baseName = path.basename(fileName, ext);
  
  let outputExt = '.chd';
  if (type === 'CSO' || type === 'CSOv2') outputExt = '.cso';
  else if (type === 'ZSO') outputExt = '.zso';
  else if (type === 'JSO') outputExt = '.jso';
  else if (type === 'DAX') outputExt = '.dax';
  
  const outputPath = path.join(outputDir, `${baseName}${outputExt}`);
  
  let cmd = '';
  let args: string[] = [];
  
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
    // maxcso uses --use-zlib etc.
    args.push(inputPath, '-o', outputPath);
  }
  
  // Respond immediately, processing happens in background
  res.json({ status: 'started' });

  // Small delay to ensure SSE client is connected
  setTimeout(() => {
    sendEvent(jobId, 'log', { level: 'info', message: `Executing: ${cmd} ${args.join(' ')}` });

    const child = spawn(cmd, args);
    
    child.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) sendEvent(jobId, 'log', { level: 'info', message: msg });
      
      // Try to parse progress (very basic example, depends on tool output)
      if (msg.includes('%')) {
        const match = msg.match(/(\d+(?:\.\d+)?)%/);
        if (match) {
          sendEvent(jobId, 'progress', { progress: parseFloat(match[1]) });
        }
      }
    });
    
    child.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) sendEvent(jobId, 'log', { level: 'warn', message: msg });
    });
    
    child.on('error', (err) => {
      sendEvent(jobId, 'log', { level: 'error', message: `Failed to start ${cmd}: ${err.message}` });
      sendEvent(jobId, 'log', { level: 'error', message: `Make sure '${cmd}' is installed and in your PATH.` });
      sendEvent(jobId, 'error', { message: err.message });
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        sendEvent(jobId, 'log', { level: 'success', message: `Conversion completed successfully.` });
        sendEvent(jobId, 'complete', { downloadUrl: `/api/download/${path.basename(outputPath)}` });
      } else {
        sendEvent(jobId, 'log', { level: 'error', message: `Process exited with code ${code}` });
        sendEvent(jobId, 'error', { message: `Process exited with code ${code}` });
      }
    });
  }, 1000);
});

app.get('/api/download/:filename', (req, res) => {
  const file = path.join(outputDir, req.params.filename);
  if (fs.existsSync(file)) {
    res.download(file);
  } else {
    res.status(404).send('File not found');
  }
});

// Vite middleware setup
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const viteModule = await import('vite');
    const createViteServer = viteModule.createServer;
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
