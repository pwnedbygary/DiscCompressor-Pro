import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Plus, 
  FolderPlus, 
  Play, 
  Square, 
  Trash2, 
  Settings, 
  Terminal, 
  Download, 
  Upload, 
  ChevronUp, 
  ChevronDown, 
  Menu, 
  X, 
  CheckCircle2, 
  AlertCircle, 
  Clock, 
  Loader2, 
  Palette,
  FileCode,
  Disc,
  ArrowRight,
  Copy
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useDropzone, DropzoneOptions } from 'react-dropzone';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import { Job, JobType, JobStatus, CompressionSettings, Theme, LogEntry } from './types';
import { DEFAULT_SETTINGS, THEMES, CHD_ALGORITHMS, HUNK_SIZES } from './constants';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

declare global {
  interface Window {
    require?: any;
  }
}

export default function App() {
  // State
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeTheme, setActiveTheme] = useState<Theme>(THEMES[0]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showLog, setShowLog] = useState(true);
  const [showSettings, setShowSettings] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  
  // App Settings State
  const [isAppSettingsOpen, setIsAppSettingsOpen] = useState(false);
  const [appSettings, setAppSettings] = useState({
    outputDirectory: '',
    defaultFormat: 'CHD',
    themeId: 'adwaita'
  });

  const logEndRef = useRef<HTMLDivElement>(null);

  // Fetch App Settings
  useEffect(() => {
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        setAppSettings(data);
        if (data.themeId) {
          const theme = THEMES.find(t => t.id === data.themeId);
          if (theme) setActiveTheme(theme);
        }
      })
      .catch(err => console.error('Failed to load settings', err));
  }, []);

  // IPC Listener for Settings Menu
  useEffect(() => {
    if (window.require) {
      const { ipcRenderer } = window.require('electron');
      const handleOpenSettings = () => setIsAppSettingsOpen(true);
      ipcRenderer.on('open-settings', handleOpenSettings);
      return () => {
        ipcRenderer.removeListener('open-settings', handleOpenSettings);
      };
    }
  }, []);

  // Save App Settings
  const saveAppSettings = async () => {
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(appSettings)
      });
      setIsAppSettingsOpen(false);
      addLog('Application settings saved', 'success');
    } catch (err) {
      addLog('Failed to save application settings', 'error');
    }
  };

  // Scroll log to bottom
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // Add log entry
  const addLog = useCallback((message: string, level: LogEntry['level'] = 'info') => {
    setLogs(prev => [
      ...prev,
      {
        id: Math.random().toString(36).substr(2, 9),
        timestamp: Date.now(),
        level,
        message,
      },
    ]);
  }, []);

  const [extraFiles, setExtraFiles] = useState<File[]>([]);

  // Handle file drop
  const onDrop = useCallback((acceptedFiles: File[]) => {
    const validJobs = acceptedFiles.filter(f => {
      const name = f.name.toLowerCase();
      return name.endsWith('.cue') || name.endsWith('.iso');
    });

    const otherFiles = acceptedFiles.filter(f => {
      const name = f.name.toLowerCase();
      return !name.endsWith('.cue') && !name.endsWith('.iso');
    });

    setExtraFiles(prev => [...prev, ...otherFiles]);

    const newJobs: Job[] = validJobs.map(file => {
      const isCue = file.name.toLowerCase().endsWith('.cue');
      
      const fileType = isCue ? 'CD' : 'DVD';
      const defaultType: JobType = fileType === 'CD' ? 'CHD' : 'CSO';

      // Set defaults based on MAME/chdman best practices
      const chdAlgorithms = fileType === 'CD' 
        ? ['lzma', 'zlib', 'flac'] 
        : ['lzma', 'zlib', 'huff'];

      return {
        id: Math.random().toString(36).substr(2, 9),
        fileName: file.name,
        fileSize: file.size,
        fileType,
        type: appSettings.defaultFormat as JobType,
        status: 'Pending',
        progress: 0,
        settings: { 
          ...DEFAULT_SETTINGS,
          chdAlgorithms,
          hunkSize: fileType === 'CD' ? 2048 : 4096 // Standard hunk sizes
        },
        addedAt: Date.now(),
        file: file,
        inputPath: (file as any).path
      };
    });

    setJobs(prev => [...prev, ...newJobs]);
    addLog(`Added ${newJobs.length} jobs`, 'info');
  }, [addLog, appSettings.defaultFormat]);

  const dropzoneOptions: any = { 
    onDrop,
    noClick: true,
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone(dropzoneOptions);

  // Actions
  const removeJob = (id: string) => {
    setJobs(prev => prev.filter(j => j.id !== id));
    if (selectedJobId === id) setSelectedJobId(null);
    addLog('Job removed from queue', 'warn');
  };

  const clearQueue = () => {
    setJobs([]);
    setSelectedJobId(null);
    addLog('Queue cleared', 'warn');
  };

  const moveJob = (id: string, direction: 'up' | 'down') => {
    const index = jobs.findIndex(j => j.id === id);
    if (index === -1) return;
    if (direction === 'up' && index === 0) return;
    if (direction === 'down' && index === jobs.length - 1) return;

    const newJobs = [...jobs];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    [newJobs[index], newJobs[targetIndex]] = [newJobs[targetIndex], newJobs[index]];
    setJobs(newJobs);
  };

  const updateJobType = (id: string, type: JobType) => {
    setJobs(prev => prev.map(j => j.id === id ? { 
      ...j, 
      type,
      status: 'Pending',
      progress: 0,
      downloadUrl: undefined,
      error: undefined
    } : j));
    addLog(`Changed job type to ${type} and requeued`, 'info');
  };

  const updateJobSettings = (id: string, settings: Partial<CompressionSettings>) => {
    setJobs(prev => prev.map(j => j.id === id ? { 
      ...j, 
      settings: { ...j.settings, ...settings },
      status: 'Pending',
      progress: 0,
      downloadUrl: undefined,
      error: undefined
    } : j));
  };

  const duplicateJob = (id: string) => {
    const jobToCopy = jobs.find(j => j.id === id);
    if (!jobToCopy) return;
    const newJob: Job = {
      ...jobToCopy,
      id: Math.random().toString(36).substr(2, 9),
      status: 'Pending',
      progress: 0,
      downloadUrl: undefined,
      error: undefined,
      addedAt: Date.now()
    };
    setJobs(prev => {
      const index = prev.findIndex(j => j.id === id);
      const newJobs = [...prev];
      newJobs.splice(index + 1, 0, newJob);
      return newJobs;
    });
    addLog(`Duplicated job ${jobToCopy.fileName}`, 'info');
  };

  const startProcessing = async () => {
    if (isProcessing || jobs.length === 0) return;
    setIsProcessing(true);
    addLog('Starting queue processing...', 'info');

    const pendingJobs = jobs.filter(j => j.status === 'Pending');
    
    if (pendingJobs.length === 0) {
      setIsProcessing(false);
      return;
    }

    // 1. Process each job sequentially
    for (const job of pendingJobs) {
      if (!job.inputPath) {
        addLog(`Skipping ${job.fileName}: Local file path not found. Please run the desktop app.`, 'error');
        setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'Error', error: 'Missing local path' } : j));
        continue;
      }

      setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'Processing' } : j));
      addLog(`Processing ${job.fileName} to ${job.type}...`, 'info');

      await new Promise<void>((resolve) => {
        const eventSource = new EventSource(`/api/events/${job.id}`);
        
        eventSource.addEventListener('log', (e: Event) => {
          const data = JSON.parse((e as MessageEvent).data);
          addLog(data.message, data.level);
        });

        eventSource.addEventListener('progress', (e: Event) => {
          const data = JSON.parse((e as MessageEvent).data);
          setJobs(prev => prev.map(j => j.id === job.id ? { ...j, progress: data.progress } : j));
        });

        eventSource.addEventListener('complete', (e: Event) => {
          const data = JSON.parse((e as MessageEvent).data);
          setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'Completed', progress: 100, downloadUrl: data.downloadUrl } : j));
          eventSource.close();
          resolve();
        });

        eventSource.addEventListener('error', (e: Event) => {
          const data = JSON.parse((e as MessageEvent).data);
          setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'Error', error: data.message } : j));
          eventSource.close();
          resolve();
        });

        // Start the process
        fetch('/api/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId: job.id,
            fileName: job.fileName,
            type: job.type,
            settings: job.settings,
            inputPath: job.inputPath
          }),
        }).catch(err => {
          addLog(`Failed to start process: ${err.message}`, 'error');
          setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'Error' } : j));
          eventSource.close();
          resolve();
        });
      });
    }

    setIsProcessing(false);
    addLog('Queue processing finished', 'success');
  };

  const exportQueue = () => {
    const data = JSON.stringify(jobs, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `disc-compressor-queue-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    addLog('Queue exported successfully', 'success');
  };

  const importQueue = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const imported = JSON.parse(event.target?.result as string);
        setJobs(prev => [...prev, ...imported]);
        addLog(`Imported ${imported.length} jobs`, 'success');
      } catch (err) {
        addLog('Failed to import queue: Invalid JSON', 'error');
      }
    };
    reader.readAsText(file);
  };

  const [showHelp, setShowHelp] = useState(false);
  const [showFileMenu, setShowFileMenu] = useState(false);
  const [showEditMenu, setShowEditMenu] = useState(false);

  const selectedJob = jobs.find(j => j.id === selectedJobId);

  return (
    <div 
      className="min-h-screen flex flex-col font-sans transition-colors duration-300"
      style={{ 
        backgroundColor: activeTheme.colors.bg, 
        color: activeTheme.colors.text 
      }}
    >
      {/* Help Modal */}
      <AnimatePresence>
        {showHelp && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black bg-opacity-50 backdrop-blur-sm">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="max-w-2xl w-full rounded-xl shadow-2xl border p-8"
              style={{ backgroundColor: activeTheme.colors.bg, borderColor: activeTheme.colors.border }}
            >
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-2xl font-bold flex items-center gap-2">
                  <AlertCircle className="w-6 h-6" /> Compression Guide
                </h2>
                <button onClick={() => setShowHelp(false)} className="p-2 hover:bg-opacity-10 hover:bg-black rounded-full">
                  <X className="w-6 h-6" />
                </button>
              </div>
              <div className="space-y-4 text-sm opacity-90 overflow-y-auto max-h-[60vh] pr-2">
                <section>
                  <h3 className="font-bold text-accent mb-1">CHD (Compressed Hunks of Data)</h3>
                  <p>The gold standard for MAME and RetroArch. Supports lossless compression for CD (BIN/CUE) and DVD (ISO). Use 2048 hunk size for CDs and 4096 for DVDs.</p>
                </section>
                <section>
                  <h3 className="font-bold text-accent mb-1">CSO (Compressed ISO)</h3>
                  <p>Standard for PSP and PS2 emulators. Uses Zlib compression. Level 9 is recommended for best size, though it may impact loading times on real hardware.</p>
                </section>
                <section>
                  <h3 className="font-bold text-accent mb-1">ZSO / JSO</h3>
                  <p>Modern alternatives to CSO. ZSO uses Zstandard (faster/better compression), while JSO uses LZ4 (extremely fast decompression).</p>
                </section>
                <section>
                  <h3 className="font-bold text-accent mb-1">Vim Themes</h3>
                  <p>Select your favorite Vim colorscheme from the Themes menu. Adwaita provides a native Linux feel, while Gruvbox and Nord offer a classic terminal aesthetic.</p>
                </section>
              </div>
              <button 
                onClick={() => setShowHelp(false)}
                className="mt-8 w-full py-3 rounded-lg font-bold transition-all hover:brightness-110"
                style={{ backgroundColor: activeTheme.colors.accent, color: activeTheme.colors.accentText }}
              >
                Got it!
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Top Menu Bar */}
      <header 
        className="h-10 flex items-center px-4 border-b text-sm select-none"
        style={{ 
          backgroundColor: activeTheme.colors.header, 
          borderColor: activeTheme.colors.border 
        }}
      >
        <div className="flex items-center gap-4">
          <div className="font-bold flex items-center gap-2">
            <Disc className="w-4 h-4" />
            DiscCompressor Pro
          </div>
          <div className="flex gap-4">
            <div className="relative">
              <button 
                className="hover:opacity-70"
                onClick={() => setShowFileMenu(!showFileMenu)}
              >
                File
              </button>
              <AnimatePresence>
                {showFileMenu && (
                  <motion.div 
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 5 }}
                    className="absolute top-full left-0 mt-1 w-48 rounded-md shadow-lg border z-50 py-1"
                    style={{ 
                      backgroundColor: activeTheme.colors.header, 
                      borderColor: activeTheme.colors.border 
                    }}
                  >
                    <button
                      className="w-full text-left px-4 py-2 hover:bg-opacity-10 hover:bg-black"
                      onClick={() => {
                        if (window.require) {
                          const { ipcRenderer } = window.require('electron');
                          ipcRenderer.send('quit-app');
                        }
                        setShowFileMenu(false);
                      }}
                    >
                      Quit
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="relative">
              <button 
                className="hover:opacity-70"
                onClick={() => setShowEditMenu(!showEditMenu)}
              >
                Edit
              </button>
              <AnimatePresence>
                {showEditMenu && (
                  <motion.div 
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 5 }}
                    className="absolute top-full left-0 mt-1 w-48 rounded-md shadow-lg border z-50 py-1"
                    style={{ 
                      backgroundColor: activeTheme.colors.header, 
                      borderColor: activeTheme.colors.border 
                    }}
                  >
                    <button
                      className="w-full text-left px-4 py-2 hover:bg-opacity-10 hover:bg-black"
                      onClick={() => {
                        setIsAppSettingsOpen(true);
                        setShowEditMenu(false);
                      }}
                    >
                      Settings
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="relative">
              <button 
                className="hover:opacity-70 flex items-center gap-1"
                onClick={() => setShowThemeMenu(!showThemeMenu)}
              >
                Themes <ChevronDown className="w-3 h-3" />
              </button>
              <AnimatePresence>
                {showThemeMenu && (
                  <motion.div 
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 5 }}
                    className="absolute top-full left-0 mt-1 w-48 rounded-md shadow-lg border z-50 py-1 max-h-64 overflow-y-auto"
                    style={{ 
                      backgroundColor: activeTheme.colors.header, 
                      borderColor: activeTheme.colors.border 
                    }}
                  >
                    {THEMES.map(t => (
                      <button
                        key={t.id}
                        className="w-full text-left px-4 py-2 hover:bg-opacity-10 hover:bg-black flex items-center justify-between"
                        onClick={() => {
                          setActiveTheme(t);
                          setAppSettings(prev => ({ ...prev, themeId: t.id }));
                          // Save theme immediately
                          fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ ...appSettings, themeId: t.id })
                          }).catch(err => console.error('Failed to save theme', err));
                          setShowThemeMenu(false);
                        }}
                      >
                        {t.name}
                        {activeTheme.id === t.id && <CheckCircle2 className="w-3 h-3" />}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <button 
              className="hover:opacity-70"
              onClick={() => setShowLog(!showLog)}
            >
              {showLog ? 'Hide Log' : 'Show Log'}
            </button>
            <button 
              className="hover:opacity-70"
              onClick={() => setShowHelp(true)}
            >
              Help
            </button>
          </div>
        </div>
      </header>

      {/* Toolbar */}
      <div 
        className="h-14 flex items-center px-4 gap-2 border-b"
        style={{ borderColor: activeTheme.colors.border }}
      >
        <label className="cursor-pointer">
          <input 
            type="file" 
            multiple 
            className="hidden" 
            onChange={(e) => {
              onDrop(Array.from(e.target.files || []));
              e.target.value = '';
            }}
          />
          <div 
            className="flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium transition-all hover:brightness-110"
            style={{ backgroundColor: activeTheme.colors.accent, color: activeTheme.colors.accentText }}
          >
            <Plus className="w-4 h-4" /> Add Files
          </div>
        </label>

        <label className="cursor-pointer">
          <input 
            type="file" 
            // @ts-ignore
            webkitdirectory="" 
            directory="" 
            className="hidden" 
            onChange={(e) => {
              onDrop(Array.from(e.target.files || []));
              e.target.value = '';
            }}
          />
          <div 
            className="flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium border hover:bg-opacity-10 hover:bg-black"
            style={{ borderColor: activeTheme.colors.border }}
          >
            <FolderPlus className="w-4 h-4" /> Add Folder
          </div>
        </label>

        <div className="w-px h-6 mx-2" style={{ backgroundColor: activeTheme.colors.border }} />

        <button 
          onClick={startProcessing}
          disabled={isProcessing || jobs.length === 0}
          className="flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50 hover:brightness-110"
          style={{ backgroundColor: activeTheme.colors.success, color: activeTheme.colors.accentText }}
        >
          <Play className="w-4 h-4" /> Start Queue
        </button>

        <button 
          onClick={() => setIsProcessing(false)}
          disabled={!isProcessing}
          className="flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium border disabled:opacity-50 hover:bg-opacity-10 hover:bg-black"
          style={{ borderColor: activeTheme.colors.border }}
        >
          <Square className="w-4 h-4" /> Stop
        </button>

        <div className="flex-1" />

        <button 
          onClick={exportQueue}
          className="p-2 rounded hover:bg-opacity-10 hover:bg-black"
          title="Export Queue"
        >
          <Download className="w-4 h-4" />
        </button>

        <label className="cursor-pointer p-2 rounded hover:bg-opacity-10 hover:bg-black" title="Import Queue">
          <input type="file" accept=".json" className="hidden" onChange={importQueue} />
          <Upload className="w-4 h-4" />
        </label>

        <button 
          onClick={clearQueue}
          className="p-2 rounded hover:bg-opacity-10 hover:bg-black text-red-500"
          title="Clear Queue"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden" {...getRootProps()}>
        <input {...getInputProps()} />
        
        {/* Job Queue */}
        <div className="flex-1 overflow-y-auto p-4">
          {jobs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center opacity-30">
              <Disc className="w-16 h-16 mb-4" />
              <p className="text-lg font-medium">Queue is empty</p>
              <p className="text-sm">Drag and drop files here to start</p>
            </div>
          ) : (
            <div className="space-y-2">
              {jobs.map((job, index) => (
                <motion.div
                  layout
                  key={job.id}
                  onClick={() => setSelectedJobId(job.id)}
                  className={cn(
                    "group flex items-center gap-4 p-3 rounded-lg border transition-all cursor-pointer",
                    selectedJobId === job.id ? "ring-2" : "hover:bg-opacity-5 hover:bg-black"
                  )}
                  style={{ 
                    borderColor: activeTheme.colors.border,
                    backgroundColor: selectedJobId === job.id ? activeTheme.colors.sidebar : 'transparent',
                    boxShadow: selectedJobId === job.id ? `0 0 0 2px ${activeTheme.colors.accent}` : 'none'
                  }}
                >
                  <div className="flex flex-col items-center gap-1">
                    <button 
                      onClick={(e) => { e.stopPropagation(); moveJob(job.id, 'up'); }}
                      className="p-1 hover:bg-opacity-20 hover:bg-black rounded disabled:opacity-20"
                      disabled={index === 0}
                    >
                      <ChevronUp className="w-3 h-3" />
                    </button>
                    <button 
                      onClick={(e) => { e.stopPropagation(); moveJob(job.id, 'down'); }}
                      className="p-1 hover:bg-opacity-20 hover:bg-black rounded disabled:opacity-20"
                      disabled={index === jobs.length - 1}
                    >
                      <ChevronDown className="w-3 h-3" />
                    </button>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium truncate">{job.fileName}</span>
                      <span className="text-xs opacity-50">{(job.fileSize / (1024 * 1024)).toFixed(2)} MB</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="flex items-center gap-1">
                        {job.fileType === 'CD' ? 'CD (BIN/CUE)' : 'DVD (ISO)'}
                        <ArrowRight className="w-3 h-3" />
                        <span className="font-bold text-accent">{job.type}</span>
                      </span>
                      <span className="opacity-50">|</span>
                      <span className={cn(
                        "flex items-center gap-1",
                        job.status === 'Completed' && "text-green-500",
                        job.status === 'Processing' && "text-blue-500",
                        job.status === 'Error' && "text-red-500"
                      )}>
                        {job.status === 'Processing' && <Loader2 className="w-3 h-3 animate-spin" />}
                        {job.status === 'Completed' && <CheckCircle2 className="w-3 h-3" />}
                        {job.status === 'Error' && <AlertCircle className="w-3 h-3" />}
                        {job.status}
                      </span>
                    </div>
                    {job.status === 'Processing' && (
                      <div className="mt-2 h-1.5 w-full bg-black bg-opacity-10 rounded-full overflow-hidden">
                        <motion.div 
                          className="h-full bg-blue-500"
                          initial={{ width: 0 }}
                          animate={{ width: `${job.progress}%` }}
                        />
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    {job.status === 'Completed' && job.downloadUrl && (
                      <a 
                        href={job.downloadUrl}
                        download
                        onClick={(e) => e.stopPropagation()}
                        className="p-2 hover:bg-green-500 hover:text-white rounded transition-colors"
                        title="Download Result"
                      >
                        <Download className="w-4 h-4" />
                      </a>
                    )}
                    <button 
                      onClick={(e) => { e.stopPropagation(); duplicateJob(job.id); }}
                      className="p-2 hover:bg-blue-500 hover:text-white rounded transition-colors"
                      title="Duplicate Job"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                    <button 
                      onClick={(e) => { e.stopPropagation(); removeJob(job.id); }}
                      className="p-2 hover:bg-red-500 hover:text-white rounded transition-colors"
                      title="Remove Job"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </div>

        {/* Settings Panel */}
        <AnimatePresence>
          {showSettings && selectedJob && (
            <motion.aside 
              initial={{ x: 300, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 300, opacity: 0 }}
              className="w-80 border-l p-6 overflow-y-auto"
              style={{ 
                backgroundColor: activeTheme.colors.sidebar, 
                borderColor: activeTheme.colors.border 
              }}
            >
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-bold flex items-center gap-2">
                  <Settings className="w-5 h-5" /> Job Settings
                </h2>
                <button onClick={() => setSelectedJobId(null)}>
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-6">
                {/* Output Type */}
                <section>
                  <label className="block text-xs font-bold uppercase tracking-wider opacity-50 mb-2">Output Format</label>
                  <select 
                    value={selectedJob.type}
                    onChange={(e) => updateJobType(selectedJob.id, e.target.value as JobType)}
                    className="w-full bg-transparent border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1"
                    style={{ borderColor: activeTheme.colors.border, ringColor: activeTheme.colors.accent }}
                  >
                    <option value="CHD">CHD (MAME/RetroArch)</option>
                    <option value="CSO">CSO (PSP/PS2)</option>
                    <option value="CSOv2">CSOv2 (Zlib/LZMA)</option>
                    <option value="ZSO">ZSO (Zstandard)</option>
                    <option value="JSO">JSO (LZ4)</option>
                    <option value="DAX">DAX (Legacy)</option>
                  </select>
                </section>

                {selectedJob.type === 'CHD' ? (
                  <>
                    {/* CHD Hunk Size */}
                    <section>
                      <label className="block text-xs font-bold uppercase tracking-wider opacity-50 mb-2">
                        Hunk Size: {selectedJob.settings.hunkSize} bytes
                      </label>
                      <input 
                        type="range"
                        min="0"
                        max={HUNK_SIZES.length - 1}
                        step="1"
                        value={HUNK_SIZES.indexOf(selectedJob.settings.hunkSize)}
                        onChange={(e) => updateJobSettings(selectedJob.id, { hunkSize: HUNK_SIZES[parseInt(e.target.value)] })}
                        className="w-full h-1.5 rounded-lg appearance-none cursor-pointer"
                        style={{ backgroundColor: activeTheme.colors.border }}
                      />
                      <div className="flex justify-between text-[10px] mt-1 opacity-50">
                        {HUNK_SIZES.map((s, i) => (
                          <span key={s}>{i % 2 === 0 ? s : '|'}</span>
                        ))}
                      </div>
                    </section>

                    {/* CHD Algorithms */}
                    <section>
                      <label className="block text-xs font-bold uppercase tracking-wider opacity-50 mb-2">Compression Algorithms</label>
                      <div className="grid grid-cols-2 gap-2">
                        {CHD_ALGORITHMS.map(algo => (
                          <label key={algo.id} className="flex items-center gap-2 text-sm cursor-pointer">
                            <input 
                              type="checkbox"
                              checked={selectedJob.settings.chdAlgorithms.includes(algo.id)}
                              onChange={(e) => {
                                const current = selectedJob.settings.chdAlgorithms;
                                const next = e.target.checked 
                                  ? [...current, algo.id]
                                  : current.filter(a => a !== algo.id);
                                if (next.length > 0) updateJobSettings(selectedJob.id, { chdAlgorithms: next });
                              }}
                              className="rounded"
                            />
                            {algo.name}
                          </label>
                        ))}
                      </div>
                    </section>
                  </>
                ) : (
                  <>
                    {/* CSO Compression Level */}
                    <section>
                      <label className="block text-xs font-bold uppercase tracking-wider opacity-50 mb-2">
                        Compression Level: {selectedJob.settings.compressionLevel}
                      </label>
                      <input 
                        type="range"
                        min="1"
                        max="9"
                        step="1"
                        value={selectedJob.settings.compressionLevel}
                        onChange={(e) => updateJobSettings(selectedJob.id, { compressionLevel: parseInt(e.target.value) })}
                        className="w-full h-1.5 rounded-lg appearance-none cursor-pointer"
                        style={{ backgroundColor: activeTheme.colors.border }}
                      />
                      <div className="flex justify-between text-[10px] mt-1 opacity-50">
                        {[1,2,3,4,5,6,7,8,9].map(n => <span key={n}>{n}</span>)}
                      </div>
                    </section>

                    <section>
                      <label className="block text-xs font-bold uppercase tracking-wider opacity-50 mb-2">Threads</label>
                      <input 
                        type="number"
                        min="1"
                        max="32"
                        value={selectedJob.settings.threads}
                        onChange={(e) => updateJobSettings(selectedJob.id, { threads: parseInt(e.target.value) })}
                        className="w-full bg-transparent border rounded px-3 py-2 text-sm"
                        style={{ borderColor: activeTheme.colors.border }}
                      />
                    </section>
                  </>
                )}

                <div className="pt-4 border-t" style={{ borderColor: activeTheme.colors.border }}>
                  <button 
                    onClick={() => {
                      const settings = selectedJob.settings;
                      const type = selectedJob.type;
                      setJobs(prev => prev.map(j => ({ 
                        ...j, 
                        type,
                        settings: { ...settings },
                        status: 'Pending',
                        progress: 0,
                        downloadUrl: undefined,
                        error: undefined
                      })));
                      addLog('Applied format and settings to all jobs and requeued', 'info');
                    }}
                    className="w-full py-2 rounded text-sm font-medium border hover:bg-opacity-10 hover:bg-black"
                    style={{ borderColor: activeTheme.colors.border }}
                  >
                    Apply to All
                  </button>
                </div>
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </main>

      {/* Log Panel */}
      <AnimatePresence>
        {showLog && (
          <motion.div 
            initial={{ height: 0 }}
            animate={{ height: 200 }}
            exit={{ height: 0 }}
            className="border-t flex flex-col overflow-hidden"
            style={{ 
              backgroundColor: activeTheme.colors.sidebar, 
              borderColor: activeTheme.colors.border 
            }}
          >
            <div 
              className="px-4 py-1.5 flex items-center justify-between text-xs font-bold uppercase tracking-widest border-b"
              style={{ borderColor: activeTheme.colors.border }}
            >
              <div className="flex items-center gap-2">
                <div 
                  className="px-2 py-0.5 rounded text-[10px]"
                  style={{ backgroundColor: activeTheme.colors.accent, color: activeTheme.colors.accentText }}
                >
                  CONSOLE
                </div>
                <Terminal className="w-3 h-3" /> 
                <span className="opacity-50">/var/log/compressor.log</span>
              </div>
              <div className="flex items-center gap-4">
                <span className="opacity-50 lowercase font-normal">utf-8 [unix]</span>
                <button onClick={() => setLogs([])} className="hover:opacity-70">Clear</button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2 font-mono text-xs space-y-1">
              {logs.length === 0 ? (
                <div className="opacity-30 italic">No logs to display</div>
              ) : (
                logs.map(log => (
                  <div key={log.id} className="flex gap-2">
                    <span className="opacity-30">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                    <span className={cn(
                      log.level === 'error' && "text-red-500",
                      log.level === 'warn' && "text-yellow-500",
                      log.level === 'success' && "text-green-500",
                      log.level === 'info' && "opacity-70"
                    )}>
                      {log.message}
                    </span>
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer Status Bar */}
      <footer 
        className="h-6 flex items-center px-4 text-[10px] border-t justify-between select-none"
        style={{ 
          backgroundColor: activeTheme.colors.header, 
          borderColor: activeTheme.colors.border 
        }}
      >
        <div className="flex gap-4">
          <span>Jobs: {jobs.length}</span>
          <span>Completed: {jobs.filter(j => j.status === 'Completed').length}</span>
          <span>Pending: {jobs.filter(j => j.status === 'Pending').length}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className={cn("w-2 h-2 rounded-full", isProcessing ? "bg-green-500 animate-pulse" : "bg-gray-400")} />
          {isProcessing ? 'Processing...' : 'Idle'}
        </div>
      </footer>
      {/* Settings Modal */}
      <AnimatePresence>
        {isAppSettingsOpen && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-md p-6 rounded-xl border shadow-2xl"
              style={{ 
                backgroundColor: activeTheme.colors.bg, 
                borderColor: activeTheme.colors.border,
                color: activeTheme.colors.text
              }}
            >
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <Settings className="w-5 h-5" />
                  Application Settings
                </h2>
                <button 
                  onClick={() => setIsAppSettingsOpen(false)}
                  className="p-1 hover:bg-black hover:bg-opacity-10 rounded-full"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Output Directory</label>
                  <div className="flex gap-2">
                    <input 
                      type="text" 
                      value={appSettings.outputDirectory}
                      onChange={(e) => setAppSettings(prev => ({ ...prev, outputDirectory: e.target.value }))}
                      className="flex-1 bg-transparent border rounded px-3 py-2 text-sm"
                      style={{ borderColor: activeTheme.colors.border }}
                      placeholder="/path/to/output"
                    />
                    <button
                      onClick={async () => {
                        if (window.require) {
                          const { ipcRenderer } = window.require('electron');
                          const selectedPath = await ipcRenderer.invoke('dialog:openDirectory');
                          if (selectedPath) {
                            setAppSettings(prev => ({ ...prev, outputDirectory: selectedPath }));
                          }
                        }
                      }}
                      className="px-4 py-2 rounded text-sm font-medium border hover:bg-black hover:bg-opacity-10"
                      style={{ borderColor: activeTheme.colors.border }}
                    >
                      Browse
                    </button>
                  </div>
                  <p className="text-xs opacity-50 mt-1">Absolute path where compressed files will be saved.</p>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Default Format</label>
                  <select 
                    value={appSettings.defaultFormat}
                    onChange={(e) => setAppSettings(prev => ({ ...prev, defaultFormat: e.target.value }))}
                    className="w-full bg-transparent border rounded px-3 py-2 text-sm"
                    style={{ borderColor: activeTheme.colors.border }}
                  >
                    <option value="CHD">CHD (CD/DVD)</option>
                    <option value="CSO">CSO (PSP/PS2)</option>
                    <option value="CSOv2">CSOv2</option>
                    <option value="ZSO">ZSO</option>
                    <option value="JSO">JSO</option>
                    <option value="DAX">DAX</option>
                  </select>
                </div>
              </div>

              <div className="mt-8 flex justify-end gap-3">
                <button 
                  onClick={() => setIsAppSettingsOpen(false)}
                  className="px-4 py-2 rounded text-sm font-medium hover:bg-black hover:bg-opacity-10"
                >
                  Cancel
                </button>
                <button 
                  onClick={saveAppSettings}
                  className="px-4 py-2 rounded text-sm font-medium text-white"
                  style={{ backgroundColor: activeTheme.colors.accent }}
                >
                  Save Settings
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
