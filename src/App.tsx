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
  Copy,
  Search
} from 'lucide-react';
import packageJson from '../package.json';
import { motion, AnimatePresence } from 'motion/react';
import { useDropzone, DropzoneOptions } from 'react-dropzone';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import { Job, JobType, JobStatus, CompressionSettings, Theme, LogEntry } from './types';
import { DEFAULT_SETTINGS, THEMES, CHD_ALGORITHMS, CD_HUNK_SIZES, DVD_HUNK_SIZES, MAXCSO_ALGORITHMS } from './constants';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const getIpcRenderer = () => {
  if (typeof window !== 'undefined' && window.require) {
    try {
      const electron = window.require('electron');
      return electron.ipcRenderer;
    } catch (e) {
      console.warn('Electron IPC not available:', e);
      return null;
    }
  }
  return null;
};

const formatBytes = (bytes: number, decimals = 2) => {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

const formatETA = (startTime?: number, progress?: number) => {
  if (!startTime || !progress || progress <= 0 || progress >= 100) return null;
  const elapsed = Date.now() - startTime;
  const totalEstimated = elapsed / (progress / 100);
  const remaining = totalEstimated - elapsed;
  const seconds = Math.floor(remaining / 1000);
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  return `${minutes}m ${remSeconds}s left`;
};

const getFilePath = (file: File, nativeFiles?: File[]): string => {
  let filePath = '';
  
  // Try to find the exact native file first, as wrapper files lose their Electron path binding
  let actualFile = file;
  if (nativeFiles && nativeFiles.length > 0) {
    const exactMatch = nativeFiles.find(nf => nf.name === file.name && nf.size === file.size);
    if (exactMatch) {
      actualFile = exactMatch;
    }
  }

  if (typeof window !== 'undefined' && window.require) {
    try {
      const electron = window.require('electron');
      if (electron.webUtils && electron.webUtils.getPathForFile) {
        // Try the native file first
        filePath = electron.webUtils.getPathForFile(actualFile);
        // Fallback to the wrapper file if native failed
        if (!filePath && actualFile !== file) {
          filePath = electron.webUtils.getPathForFile(file);
        }
      }
    } catch (e) {
      console.warn('Failed to get webUtils:', e);
    }
  }
  
  if (!filePath && nativeFiles && nativeFiles.length > 0) {
    // Try to resolve from native files
    const exactMatch = nativeFiles.find(nf => nf.name === file.name && nf.size === file.size);
    if (exactMatch && (exactMatch as any).path) {
      filePath = (exactMatch as any).path;
    } else if ((actualFile as any).path && typeof window !== 'undefined' && window.require) {
      try {
        const path = window.require('path');
        const relativePath = (actualFile as any).path;
        // Filter out '.' and empty strings
        const parts = relativePath.split(/[/\\]/).filter(p => p && p !== '.');
        if (parts.length > 0) {
          const topLevelName = parts[0];
          const parentFolder = nativeFiles.find(nf => nf.name === topLevelName);
          if (parentFolder && (parentFolder as any).path) {
            const parentDir = path.dirname((parentFolder as any).path);
            filePath = path.join(parentDir, relativePath);
          }
        }
      } catch (e) {
        console.warn('Failed to resolve path from native files:', e);
      }
    }
  }

  // If we still don't have a valid absolute path, try the actualFile's path property
  // which in Electron should be the absolute path (unless overwritten by dropzone)
  if (!filePath && (actualFile as any).path) {
    filePath = (actualFile as any).path;
  }

  return filePath || (file as any).path || '';
};

export default function App() {
  // State
  const [jobs, setJobs] = useState<Job[]>([]);
  const jobsRef = useRef(jobs);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);
  const [activeTheme, setActiveTheme] = useState<Theme>(THEMES[0]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logSearchQuery, setLogSearchQuery] = useState('');
  const [showLog, setShowLog] = useState(true);
  const [showSettings, setShowSettings] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [draftSettings, setDraftSettings] = useState<any>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionBox, setSelectionBox] = useState<{startX: number, startY: number, currentX: number, currentY: number} | null>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const [showFileMenu, setShowFileMenu] = useState(false);
  const [showEditMenu, setShowEditMenu] = useState(false);
  const [consoleHeight, setConsoleHeight] = useState(200);
  const [isDraggingConsole, setIsDraggingConsole] = useState(false);
  const [draggedJobIndex, setDraggedJobIndex] = useState<number | null>(null);
  
  // App Settings State
  const [isAppSettingsOpen, setIsAppSettingsOpen] = useState(false);
  const [appSettings, setAppSettings] = useState({
    outputDirectory: '',
    defaultFormat: 'CHD',
    themeId: 'adwaita',
    deleteOriginals: false,
    autoGenerateM3U: false,
    minimizeToTray: false,
    chdmanPath: '',
    maxcsoPath: ''
  });

  const logEndRef = useRef<HTMLDivElement>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const isAutoScrollEnabled = useRef<boolean>(true);
  const headerRef = useRef<HTMLDivElement>(null);

  // Handle click outside to close menus
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (headerRef.current && !headerRef.current.contains(event.target as Node)) {
        setShowFileMenu(false);
        setShowEditMenu(false);
        setShowThemeMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Handle drag selection
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isSelecting || !selectionBox) return;
      setSelectionBox(prev => prev ? { ...prev, currentX: e.clientX, currentY: e.clientY } : null);

      // Calculate intersection
      if (listContainerRef.current) {
        const boxLeft = Math.min(selectionBox.startX, e.clientX);
        const boxRight = Math.max(selectionBox.startX, e.clientX);
        const boxTop = Math.min(selectionBox.startY, e.clientY);
        const boxBottom = Math.max(selectionBox.startY, e.clientY);

        const jobElements = listContainerRef.current.querySelectorAll('[data-job-id]');
        const newSelectedIds: string[] = [];
        
        jobElements.forEach(el => {
          const rect = el.getBoundingClientRect();
          const isIntersecting = !(
            rect.right < boxLeft || 
            rect.left > boxRight || 
            rect.bottom < boxTop || 
            rect.top > boxBottom
          );
          if (isIntersecting) {
            const id = el.getAttribute('data-job-id');
            if (id) newSelectedIds.push(id);
          }
        });
        
        // If holding shift/ctrl, we might want to merge, but standard drag selection usually overrides unless shift is held.
        // For simplicity, let's just override during drag.
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          setSelectedJobIds(prev => Array.from(new Set([...prev, ...newSelectedIds])));
        } else {
          setSelectedJobIds(newSelectedIds);
        }
      }
    };

    const handleMouseUp = () => {
      setIsSelecting(false);
      setSelectionBox(null);
    };

    if (isSelecting) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isSelecting, selectionBox]);

  // Handle console dragging
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingConsole) return;
      const newHeight = window.innerHeight - e.clientY - 24; // 24 is footer height
      setConsoleHeight(Math.max(100, Math.min(newHeight, window.innerHeight - 100)));
    };

    const handleMouseUp = () => {
      setIsDraggingConsole(false);
    };

    if (isDraggingConsole) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingConsole]);

  // Fetch App Settings
  useEffect(() => {
    const ipcRenderer = getIpcRenderer();
    if (ipcRenderer) {
      ipcRenderer.invoke('get-settings')
        .then((data: any) => {
          setAppSettings(data);
          if (data.themeId) {
            const theme = THEMES.find(t => t.id === data.themeId);
            if (theme) setActiveTheme(theme);
          }
        })
        .catch((err: any) => console.error('Failed to load settings', err));
    }
  }, []);

  // IPC Listener for Settings Menu
  useEffect(() => {
    const ipcRenderer = getIpcRenderer();
    if (ipcRenderer) {
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
      const ipcRenderer = getIpcRenderer();
      if (ipcRenderer) {
        await ipcRenderer.invoke('save-settings', appSettings);
      }
      setIsAppSettingsOpen(false);
      addLog('Application settings saved', 'success');
    } catch (err) {
      addLog('Failed to save application settings', 'error');
    }
  };

  // Scroll log to bottom
  useEffect(() => {
    if (logEndRef.current && isAutoScrollEnabled.current) {
      logEndRef.current.scrollIntoView({ behavior: 'auto' });
    }
  }, [logs]);

  const handleLogScroll = () => {
    if (!logContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
    // If we are within 20px of the bottom, enable auto-scroll
    isAutoScrollEnabled.current = scrollHeight - scrollTop - clientHeight < 20;
  };

  // Add log entry
  const addLog = useCallback((message: string, level: LogEntry['level'] = 'info') => {
    setLogs(prev => {
      // If the new message and the last message are both progress updates (e.g. "Compressing, XX% complete..."),
      // replace the last message instead of appending a new one to prevent log spam.
      if (prev.length > 0) {
        const lastLog = prev[prev.length - 1];
        const isProgressMsg = (msg: string) => (msg.startsWith('Compressing,') || msg.startsWith('Extracting,')) && msg.includes('% complete');
        if (isProgressMsg(message) && isProgressMsg(lastLog.message)) {
          const newLogs = [...prev];
          newLogs[newLogs.length - 1] = {
            ...lastLog,
            timestamp: Date.now(),
            message,
          };
          return newLogs;
        }
      }
      
      return [
        ...prev,
        {
          id: Math.random().toString(36).substr(2, 9),
          timestamp: Date.now(),
          level,
          message,
        },
      ];
    });
  }, []);

  const [extraFiles, setExtraFiles] = useState<File[]>([]);
  const nativeFilesRef = useRef<File[]>([]);

  // Capture native files synchronously during the drop event before the browser clears dataTransfer
  useEffect(() => {
    const handleGlobalDrop = (e: DragEvent) => {
      if (e.dataTransfer && e.dataTransfer.files) {
        nativeFilesRef.current = Array.from(e.dataTransfer.files);
      }
    };
    window.addEventListener('drop', handleGlobalDrop, true); // Use capture phase
    return () => window.removeEventListener('drop', handleGlobalDrop, true);
  }, []);

  // Handle file drop
  const onDrop = useCallback(async (acceptedFiles: File[], fileRejections?: any[], event?: any) => {
    // Try to get native files from event if available, as react-dropzone might wrap them
    // or overwrite the path property which breaks Electron's path resolution
    let nativeFiles: File[] = [];
    if (event && event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      nativeFiles = Array.from(event.dataTransfer.files);
    } else if (event && event.target && event.target.files && event.target.files.length > 0) {
      nativeFiles = Array.from(event.target.files);
    } else if (nativeFilesRef.current.length > 0) {
      nativeFiles = nativeFilesRef.current;
    } else {
      nativeFiles = acceptedFiles;
    }

    const validJobs = acceptedFiles.filter(f => {
      const name = f.name.toLowerCase();
      return name.endsWith('.cue') || name.endsWith('.gdi') || name.endsWith('.iso') || name.endsWith('.chd') || name.endsWith('.cso') || name.endsWith('.zso');
    }).map(f => {
      // Find the corresponding native file to preserve the original path
      const nativeFile = nativeFiles.find(nf => nf.name === f.name && nf.size === f.size);
      return nativeFile || f;
    });

    const otherFiles = acceptedFiles.filter(f => {
      const name = f.name.toLowerCase();
      return !name.endsWith('.cue') && !name.endsWith('.gdi') && !name.endsWith('.iso') && !name.endsWith('.chd') && !name.endsWith('.cso') && !name.endsWith('.zso');
    }).map(f => {
      const nativeFile = nativeFiles.find(nf => nf.name === f.name && nf.size === f.size);
      return nativeFile || f;
    });

    setExtraFiles(prev => [...prev, ...otherFiles]);

    const ipcRenderer = getIpcRenderer();

    const newJobs: Job[] = await Promise.all(validJobs.map(async file => {
      const name = file.name.toLowerCase();
      const isCueOrGdi = name.endsWith('.cue') || name.endsWith('.gdi');
      const isCompressed = name.endsWith('.chd') || name.endsWith('.cso') || name.endsWith('.zso');
      
      const fileType = isCueOrGdi ? 'CD' : 'DVD';
      
      let defaultType: JobType = appSettings.defaultFormat as JobType;
      if (isCompressed) {
        defaultType = 'Extract';
      }

      // Set defaults based on MAME/chdman best practices
      const chdAlgorithms = fileType === 'CD' 
        ? ['cdzl', 'cdlz', 'cdfl'] 
        : ['zlib', 'lzma', 'huff', 'flac'];

      const inputPath = getFilePath(file, nativeFiles);
      let realFileSize = file.size;
      if (ipcRenderer && inputPath) {
        realFileSize = await ipcRenderer.invoke('get-real-file-size', inputPath);
      }

      return {
        id: Math.random().toString(36).substr(2, 9),
        fileName: file.name,
        fileSize: realFileSize,
        fileType,
        type: defaultType,
        status: 'Pending',
        progress: 0,
        settings: { 
          ...DEFAULT_SETTINGS,
          chdAlgorithms,
          hunkSize: fileType === 'CD' ? 0 : 0, // Auto by default
          extractFormat: name.endsWith('.chd') ? 'BIN/CUE' : 'ISO'
        },
        addedAt: Date.now(),
        file: file,
        inputPath
      };
    }));

    setJobs(prev => [...prev, ...newJobs]);
    addLog(`Added ${newJobs.length} jobs`, 'info');
  }, [addLog, appSettings.defaultFormat]);

  const dropzoneOptions: any = { 
    onDrop,
    noClick: true,
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone(dropzoneOptions);

  // Actions
  const removeJob = async (id: string) => {
    const job = jobs.find(j => j.id === id);
    if (job && job.status === 'Processing') {
      const ipcRenderer = getIpcRenderer();
      if (ipcRenderer) {
        await ipcRenderer.invoke('cancel-job', id);
      }
    }
    setJobs(prev => prev.filter(j => j.id !== id));
    setSelectedJobIds(prev => prev.filter(jId => jId !== id));
    if (lastSelectedId === id) setLastSelectedId(null);
    addLog('Job removed from queue', 'warn');
  };

  const clearQueue = async () => {
    const ipcRenderer = getIpcRenderer();
    if (ipcRenderer) {
      const processingJobs = jobs.filter(j => j.status === 'Processing');
      for (const job of processingJobs) {
        await ipcRenderer.invoke('cancel-job', job.id);
      }
    }
    setJobs([]);
    setSelectedJobIds([]);
    setLastSelectedId(null);
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

  const updateJobFileType = (id: string, fileType: 'CD' | 'DVD') => {
    setJobs(prev => prev.map(j => {
      if (j.id === id) {
        // Adjust hunk size to a valid one for the new type if needed
        let newHunkSize = j.settings.hunkSize;
        if (fileType === 'CD' && !CD_HUNK_SIZES.includes(newHunkSize)) {
          newHunkSize = 2448;
        } else if (fileType === 'DVD' && !DVD_HUNK_SIZES.includes(newHunkSize)) {
          newHunkSize = 4096;
        }
        
        // Update default algorithms for the new type
        const newAlgorithms = fileType === 'CD'
          ? ['cdzl', 'cdlz', 'cdfl']
          : ['zlib', 'lzma', 'huff', 'flac'];
        
        return { 
          ...j, 
          fileType,
          settings: { ...j.settings, hunkSize: newHunkSize, chdAlgorithms: newAlgorithms },
          status: 'Pending',
          progress: 0,
          downloadUrl: undefined,
          error: undefined
        };
      }
      return j;
    }));
    addLog(`Changed source type to ${fileType} and requeued`, 'info');
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

  const isProcessingRef = useRef(isProcessing);
  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  const stopProcessing = async () => {
    setIsProcessing(false);
    isProcessingRef.current = false;
    addLog('Stopping queue...', 'warn');
    const ipcRenderer = getIpcRenderer();
    if (ipcRenderer) {
      const processingJobs = jobs.filter(j => j.status === 'Processing');
      for (const job of processingJobs) {
        await ipcRenderer.invoke('cancel-job', job.id);
      }
    }
  };

  const startProcessing = async () => {
    if (isProcessing || jobsRef.current.length === 0) return;
    setIsProcessing(true);
    isProcessingRef.current = true;
    addLog('Starting queue processing...', 'info');

    // 1. Process each job sequentially, fetching the next pending job dynamically
    while (isProcessingRef.current) {
      const job = jobsRef.current.find(j => j.status === 'Pending');
      if (!job) {
        break; // No more pending jobs
      }
      
      const ipcRenderer = getIpcRenderer();
      
      if (!ipcRenderer) {
        // Mock processing for web preview
        addLog(`[Web Preview] Simulating processing for ${job.fileName}...`, 'info');
        setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'Processing' } : j));
        
        await new Promise<void>((resolve) => {
          let progress = 0;
          const interval = setInterval(() => {
            if (!isProcessingRef.current) {
              clearInterval(interval);
              setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'Pending', progress: 0 } : j));
              resolve();
              return;
            }
            progress += Math.random() * 15;
            if (progress >= 100) {
              progress = 100;
              clearInterval(interval);
              setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'Completed', progress: 100 } : j));
              addLog(`[Web Preview] Simulated completion for ${job.fileName}`, 'success');
              resolve();
            } else {
              setJobs(prev => prev.map(j => j.id === job.id ? { ...j, progress } : j));
            }
          }, 500);
        });
        continue;
      }

      if (!job.inputPath) {
        addLog(`Skipping ${job.fileName}: Local file path not found. Please run the desktop app.`, 'error');
        setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'Error', error: 'Missing local path' } : j));
        continue;
      }

      setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'Processing', startTime: Date.now() } : j));
      addLog(`Processing ${job.fileName} to ${job.type}...`, 'info');

      await new Promise<void>((resolve) => {
        const handleJobEvent = (event: any, { type, data }: any) => {
          if (type === 'log') {
            addLog(data.message, data.level);
          } else if (type === 'progress') {
            setJobs(prev => prev.map(j => j.id === job.id ? { ...j, progress: data.progress } : j));
          } else if (type === 'complete') {
            setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'Completed', progress: 100, downloadUrl: data.outputPath, finalSize: data.finalSize } : j));
            ipcRenderer.removeListener(`job-event-${job.id}`, handleJobEvent);
            resolve();
          } else if (type === 'error') {
            // If it was cancelled, we might want to set it back to pending or error.
            const newStatus = data.message === 'Cancelled' ? 'Pending' : 'Error';
            setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: newStatus, error: data.message } : j));
            ipcRenderer.removeListener(`job-event-${job.id}`, handleJobEvent);
            resolve();
          }
        };

        ipcRenderer.on(`job-event-${job.id}`, handleJobEvent);

        ipcRenderer.invoke('process-file', {
          jobId: job.id,
          fileName: job.fileName,
          type: job.type,
          fileType: job.fileType,
          settings: job.settings,
          inputPath: job.inputPath
        }).catch((err: any) => {
          addLog(`Failed to start process: ${err.message}`, 'error');
          setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'Error' } : j));
          ipcRenderer.removeListener(`job-event-${job.id}`, handleJobEvent);
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
  const [maxThreads, setMaxThreads] = useState(8);

  useEffect(() => {
    // Try to get hardware concurrency
    if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
      setMaxThreads(navigator.hardwareConcurrency);
    }
  }, []);

  const selectedJob = jobs.find(j => j.id === (lastSelectedId || selectedJobIds[0]));

  // Sync draft settings when selected job changes
  useEffect(() => {
    if (selectedJob) {
      setDraftSettings({
        settings: { ...selectedJob.settings },
        type: selectedJob.type,
        fileType: selectedJob.fileType
      });
    } else {
      setDraftSettings(null);
    }
  }, [selectedJob?.id, selectedJobIds.length]);

  const totalSpaceSaved = jobs.reduce((acc, job) => {
    const isCompressionJob = ['CHD', 'CSO', 'CSOv2', 'ZSO'].includes(job.type);
    if (isCompressionJob && job.status === 'Completed' && job.finalSize && job.finalSize < job.fileSize) {
      return acc + (job.fileSize - job.finalSize);
    }
    return acc;
  }, 0);

  return (
    <div 
      className="h-screen flex flex-col font-sans transition-colors duration-300"
      style={{ 
        backgroundColor: activeTheme.colors.bg, 
        color: activeTheme.colors.text 
      }}
    >
      <style>{`
        .theme-hover:hover {
          background-color: ${activeTheme.colors.accent} !important;
          color: ${activeTheme.colors.accentText} !important;
        }
        .theme-select option {
          background-color: ${activeTheme.colors.bg};
          color: ${activeTheme.colors.text};
        }
      `}</style>
      
      {/* Help Modal */}
      <AnimatePresence>
        {showHelp && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 backdrop-blur-md" style={{ backgroundColor: `${activeTheme.colors.bg}80` }}>
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
                <button onClick={() => setShowHelp(false)} className="p-2 theme-hover rounded-full">
                  <X className="w-6 h-6" />
                </button>
              </div>
              <div className="space-y-4 text-sm opacity-90 overflow-y-auto max-h-[60vh] pr-2">
                <section>
                  <h3 className="font-bold text-accent mb-1">CHD (Compressed Hunks of Data)</h3>
                  <p>The gold standard for MAME and RetroArch. Supports lossless compression for CD (BIN/CUE/GDI) and DVD (ISO). Use 2048 hunk size for Dreamcast GDI, 2448 for CDs, and 4096 for DVDs.</p>
                </section>
                <section>
                  <h3 className="font-bold text-accent mb-1">CSO (Compressed ISO)</h3>
                  <p>Standard for PSP and PS2 emulators. Uses Zlib compression. Level 9 is recommended for best size, though it may impact loading times on real hardware.</p>
                </section>
                <section>
                  <h3 className="font-bold text-accent mb-1">ZSO</h3>
                  <p>Modern alternative to CSO. ZSO uses Zstandard (faster/better compression).</p>
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
        ref={headerRef}
        className="h-10 flex items-center px-4 border-b text-sm select-none"
        style={{ 
          backgroundColor: activeTheme.colors.header, 
          borderColor: activeTheme.colors.border 
        }}
      >
        <div className="flex items-center gap-4">
          <div className="font-bold flex items-center gap-2">
            <Disc className="w-4 h-4" />
            DiscCompressor Pro <span className="text-xs font-normal opacity-50">v{packageJson.version}</span>
          </div>
          <div className="flex gap-4">
            <div className="relative">
              <button 
                className="hover:opacity-70"
                onClick={() => {
                  setShowFileMenu(!showFileMenu);
                  setShowEditMenu(false);
                  setShowThemeMenu(false);
                }}
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
                      className="w-full text-left px-4 py-2 theme-hover"
                      onClick={() => {
                        const ipcRenderer = getIpcRenderer();
                        if (ipcRenderer) {
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
                onClick={() => {
                  setShowEditMenu(!showEditMenu);
                  setShowFileMenu(false);
                  setShowThemeMenu(false);
                }}
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
                      className="w-full text-left px-4 py-2 theme-hover"
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
                onClick={() => {
                  setShowThemeMenu(!showThemeMenu);
                  setShowFileMenu(false);
                  setShowEditMenu(false);
                }}
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
                        className="w-full text-left px-4 py-2 theme-hover flex items-center justify-between"
                        onClick={() => {
                          setActiveTheme(t);
                          setAppSettings(prev => ({ ...prev, themeId: t.id }));
                          // Save theme immediately
                          const ipcRenderer = getIpcRenderer();
                          if (ipcRenderer) {
                            ipcRenderer.invoke('save-settings', { ...appSettings, themeId: t.id })
                              .catch((err: any) => console.error('Failed to save theme', err));
                          }
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
              onDrop(Array.from(e.target.files || []), [], e);
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
              onDrop(Array.from(e.target.files || []), [], e);
              e.target.value = '';
            }}
          />
          <div 
            className="flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium border theme-hover"
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
          onClick={stopProcessing}
          disabled={!isProcessing}
          className="flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium border disabled:opacity-50 theme-hover"
          style={{ borderColor: activeTheme.colors.border }}
        >
          <Square className="w-4 h-4" /> Stop
        </button>

        <div className="flex-1 flex items-center justify-center">
          {totalSpaceSaved > 0 && (
            <span className="text-sm font-medium" style={{ color: activeTheme.colors.success }}>
              Total Space Saved: {formatBytes(totalSpaceSaved)}
            </span>
          )}
        </div>

        <button 
          onClick={exportQueue}
          className="p-2 rounded theme-hover"
          title="Export Queue"
        >
          <Download className="w-4 h-4" />
        </button>

        <label className="cursor-pointer p-2 rounded theme-hover" title="Import Queue">
          <input type="file" accept=".json" className="hidden" onChange={importQueue} />
          <Upload className="w-4 h-4" />
        </label>

        <button 
          onClick={clearQueue}
          className="p-2 rounded hover:bg-red-500 hover:text-white transition-colors"
          title="Clear Queue"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden" {...getRootProps()}>
        <input {...getInputProps()} />
        
        {/* Job Queue */}
        <div 
          className="flex-1 overflow-y-auto p-4 relative"
          ref={listContainerRef}
          onMouseDown={(e) => {
            // Only start selection if clicking directly on the container (not on a job)
            if (e.target === listContainerRef.current) {
              setIsSelecting(true);
              setSelectionBox({ startX: e.clientX, startY: e.clientY, currentX: e.clientX, currentY: e.clientY });
              if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
                setSelectedJobIds([]);
              }
            }
          }}
        >
          {selectionBox && isSelecting && (
            <div 
              className="fixed border bg-blue-500/20 pointer-events-none z-50"
              style={{
                left: Math.min(selectionBox.startX, selectionBox.currentX),
                top: Math.min(selectionBox.startY, selectionBox.currentY),
                width: Math.abs(selectionBox.currentX - selectionBox.startX),
                height: Math.abs(selectionBox.currentY - selectionBox.startY),
                borderColor: activeTheme.colors.accent
              }}
            />
          )}
          {jobs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center opacity-30 pointer-events-none">
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
                  data-job-id={job.id}
                  draggable
                  onDragStart={(e) => {
                    setDraggedJobIndex(index);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (draggedJobIndex === null || draggedJobIndex === index) return;
                    
                    const newJobs = [...jobs];
                    const draggedJob = newJobs[draggedJobIndex];
                    newJobs.splice(draggedJobIndex, 1);
                    newJobs.splice(index, 0, draggedJob);
                    setJobs(newJobs);
                    setDraggedJobIndex(index);
                  }}
                  onDragEnd={() => {
                    setDraggedJobIndex(null);
                  }}
                  onClick={(e) => {
                    if (e.shiftKey && lastSelectedId) {
                      const lastIndex = jobs.findIndex(j => j.id === lastSelectedId);
                      const currentIndex = index;
                      const start = Math.min(lastIndex, currentIndex);
                      const end = Math.max(lastIndex, currentIndex);
                      const rangeIds = jobs.slice(start, end + 1).map(j => j.id);
                      
                      if (e.ctrlKey || e.metaKey) {
                        setSelectedJobIds(prev => Array.from(new Set([...prev, ...rangeIds])));
                      } else {
                        setSelectedJobIds(rangeIds);
                      }
                    } else if (e.ctrlKey || e.metaKey) {
                      setSelectedJobIds(prev => 
                        prev.includes(job.id) ? prev.filter(id => id !== job.id) : [...prev, job.id]
                      );
                      setLastSelectedId(job.id);
                    } else {
                      setSelectedJobIds([job.id]);
                      setLastSelectedId(job.id);
                    }
                  }}
                  className={cn(
                    "group flex items-center gap-4 p-3 rounded-lg border transition-all cursor-pointer",
                    selectedJobIds.includes(job.id) ? "ring-2" : "theme-hover",
                    draggedJobIndex === index ? "opacity-50" : "opacity-100"
                  )}
                  style={{ 
                    borderColor: activeTheme.colors.border,
                    backgroundColor: selectedJobIds.includes(job.id) ? activeTheme.colors.sidebar : 'transparent',
                    boxShadow: selectedJobIds.includes(job.id) ? `0 0 0 2px ${activeTheme.colors.accent}` : 'none'
                  }}
                >
                  <div className="flex flex-col items-center gap-1 cursor-grab active:cursor-grabbing">
                    <button 
                      onClick={(e) => { e.stopPropagation(); moveJob(job.id, 'up'); }}
                      className="p-1 theme-hover rounded disabled:opacity-20"
                      disabled={index === 0}
                    >
                      <ChevronUp className="w-3 h-3" />
                    </button>
                    <button 
                      onClick={(e) => { e.stopPropagation(); moveJob(job.id, 'down'); }}
                      className="p-1 theme-hover rounded disabled:opacity-20"
                      disabled={index === jobs.length - 1}
                    >
                      <ChevronDown className="w-3 h-3" />
                    </button>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium truncate">{job.fileName}</span>
                      <span className="text-xs opacity-50">{formatBytes(job.fileSize)}</span>
                      {['CHD', 'CSO', 'CSOv2', 'ZSO'].includes(job.type) && job.status === 'Completed' && job.finalSize && job.finalSize < job.fileSize && (
                        <span className="text-xs font-medium" style={{ color: activeTheme.colors.success }}>
                          Saved {formatBytes(job.fileSize - job.finalSize)} ({(100 - (job.finalSize / job.fileSize) * 100).toFixed(1)}%)
                        </span>
                      )}
                      {job.status === 'Processing' && job.startTime && job.progress > 0 && (
                        <span className="text-xs font-medium opacity-70">
                          {formatETA(job.startTime, job.progress)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="flex items-center gap-1">
                        {job.fileName.split('.').pop()?.toUpperCase()}
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
                      <div 
                        className="mt-2 h-1.5 w-full rounded-full overflow-hidden"
                        style={{ backgroundColor: activeTheme.colors.border }}
                      >
                        <div 
                          className="h-full transition-all duration-300 ease-out"
                          style={{ 
                            backgroundColor: activeTheme.colors.accent,
                            width: `${job.progress}%`
                          }}
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
                        className="p-2 theme-hover rounded transition-colors"
                        title="Download Result"
                      >
                        <Download className="w-4 h-4" />
                      </a>
                    )}
                    <button 
                      onClick={(e) => { e.stopPropagation(); duplicateJob(job.id); }}
                      className="p-2 theme-hover rounded transition-colors"
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
          {showSettings && selectedJob && draftSettings && (
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
                <button onClick={() => setSelectedJobIds([])}>
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-6">
                {/* Source Type */}
                {draftSettings.type === 'CHD' && (
                  <section>
                    <label className="block text-xs font-bold uppercase tracking-wider opacity-50 mb-2">Source Type</label>
                    <select 
                      value={draftSettings.fileType}
                      onChange={(e) => {
                        const newFileType = e.target.value as 'CD' | 'DVD';
                        let newHunkSize = draftSettings.settings.hunkSize;
                        if (newFileType === 'CD' && !CD_HUNK_SIZES.includes(newHunkSize)) newHunkSize = 0;
                        if (newFileType === 'DVD' && !DVD_HUNK_SIZES.includes(newHunkSize)) newHunkSize = 0;
                        const newAlgorithms = newFileType === 'CD' ? ['cdzl', 'cdlz', 'cdfl'] : ['zlib', 'lzma', 'huff', 'flac'];
                        
                        setDraftSettings((prev: any) => ({
                          ...prev,
                          fileType: newFileType,
                          settings: { ...prev.settings, hunkSize: newHunkSize, chdAlgorithms: newAlgorithms }
                        }));
                      }}
                      className="w-full bg-transparent border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 theme-select"
                      style={{ borderColor: activeTheme.colors.border, ringColor: activeTheme.colors.accent }}
                    >
                      <option value="CD">CD (BIN/CUE/GDI/ISO)</option>
                      <option value="DVD">DVD (ISO)</option>
                    </select>
                  </section>
                )}

                {/* Output Type */}
                <section>
                  <label className="block text-xs font-bold uppercase tracking-wider opacity-50 mb-2">Output Format</label>
                  <select 
                    value={draftSettings.type}
                    onChange={(e) => {
                      const newType = e.target.value as JobType;
                      setDraftSettings((prev: any) => {
                        let newDraft = { ...prev, type: newType };
                        if (newType === 'CSO' || newType === 'ZSO' || newType === 'CSOv2') {
                          const validMaxcsoAlgos = MAXCSO_ALGORITHMS.filter(a => {
                            if (newType === 'CSO' && a.type === 'lz4') return false;
                            if (newType === 'ZSO' && a.type === 'deflate') return false;
                            return true;
                          }).map(a => a.id);
                          let filtered = prev.settings.maxcsoAlgorithms.filter((a: string) => validMaxcsoAlgos.includes(a));
                          if (filtered.length === 0) {
                            filtered = newType === 'ZSO' ? ['use-lz4', 'use-lz4brute'] : ['use-zlib', 'use-7zdeflate', 'use-libdeflate'];
                          }
                          newDraft.settings = { ...prev.settings, maxcsoAlgorithms: filtered };
                        }
                        return newDraft;
                      });
                    }}
                    className="w-full bg-transparent border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 theme-select"
                    style={{ borderColor: activeTheme.colors.border, ringColor: activeTheme.colors.accent }}
                  >
                    <option value="CHD">CHD (MAME/RetroArch)</option>
                    <option value="CSO">CSO (PSP/PS2)</option>
                    <option value="CSOv2">CSOv2 (Zlib/LZMA)</option>
                    <option value="ZSO">ZSO (Zstandard)</option>
                    <option value="Extract">Extract (Decompress)</option>
                    <option value="Info">Info (CHDMAN)</option>
                    <option value="Verify">Verify (CHDMAN)</option>
                  </select>
                </section>

                {draftSettings.type === 'CHD' ? (
                  <>
                    {/* CHD Hunk Size */}
                    <section>
                      <label className="block text-xs font-bold uppercase tracking-wider opacity-50 mb-2">
                        Hunk Size: {draftSettings.settings.hunkSize === 0 ? 'Auto' : `${draftSettings.settings.hunkSize} bytes`}
                      </label>
                      <input 
                        type="range"
                        min="0"
                        max={(draftSettings.fileType === 'CD' ? CD_HUNK_SIZES : DVD_HUNK_SIZES).length - 1}
                        step="1"
                        value={(draftSettings.fileType === 'CD' ? CD_HUNK_SIZES : DVD_HUNK_SIZES).indexOf(draftSettings.settings.hunkSize)}
                        onChange={(e) => setDraftSettings((prev: any) => ({ ...prev, settings: { ...prev.settings, hunkSize: (prev.fileType === 'CD' ? CD_HUNK_SIZES : DVD_HUNK_SIZES)[parseInt(e.target.value)] } }))}
                        className="w-full h-1.5 rounded-lg appearance-none cursor-pointer"
                        style={{ backgroundColor: activeTheme.colors.border }}
                      />
                      <div className="flex justify-between text-[10px] mt-1 opacity-50">
                        {(draftSettings.fileType === 'CD' ? CD_HUNK_SIZES : DVD_HUNK_SIZES).map((s, i) => (
                          <span key={s}>{i % 2 === 0 ? (s === 0 ? 'Auto' : s) : '|'}</span>
                        ))}
                      </div>
                    </section>

                    {/* CHD Algorithms */}
                    <section>
                      <label className="block text-xs font-bold uppercase tracking-wider opacity-50 mb-2">Compression Algorithms</label>
                      <div className="grid grid-cols-1 gap-2">
                        {CHD_ALGORITHMS.map(algo => {
                          const isEnabled = algo.type === draftSettings.fileType;
                          return (
                            <label 
                              key={algo.id} 
                              className={cn(
                                "flex items-center gap-2 text-sm",
                                isEnabled ? "cursor-pointer" : "opacity-30 cursor-not-allowed"
                              )}
                            >
                              <input 
                                type="checkbox"
                                disabled={!isEnabled}
                                checked={draftSettings.settings.chdAlgorithms.includes(algo.id)}
                                onChange={(e) => {
                                  const current = draftSettings.settings.chdAlgorithms;
                                  const next = e.target.checked 
                                    ? [...current, algo.id]
                                    : current.filter((a: string) => a !== algo.id);
                                  if (next.length > 0) setDraftSettings((prev: any) => ({ ...prev, settings: { ...prev.settings, chdAlgorithms: next } }));
                                }}
                                className="rounded"
                              />
                              {algo.name}
                            </label>
                          );
                        })}
                      </div>
                    </section>

                    {/* CHD Threads */}
                    <section>
                      <label className="block text-xs font-bold uppercase tracking-wider opacity-50 mb-2">
                        Threads: {draftSettings.settings.threads}
                      </label>
                      <input 
                        type="range"
                        min="1"
                        max={maxThreads}
                        step="1"
                        value={draftSettings.settings.threads}
                        onChange={(e) => setDraftSettings((prev: any) => ({ ...prev, settings: { ...prev.settings, threads: parseInt(e.target.value) } }))}
                        className="w-full h-1.5 rounded-lg appearance-none cursor-pointer"
                        style={{ backgroundColor: activeTheme.colors.border }}
                      />
                      <div className="flex justify-between text-[10px] mt-1 opacity-50">
                        {Array.from({ length: maxThreads }, (_, i) => i + 1).map(n => (
                          <span key={n}>
                            {n === 1 || n === maxThreads || n % 4 === 0 ? n : '|'}
                          </span>
                        ))}
                      </div>
                    </section>
                  </>
                ) : draftSettings.type === 'Extract' ? (
                  <>
                    {selectedJob.fileName.toLowerCase().endsWith('.chd') && (
                      <section>
                        <label className="block text-xs font-bold uppercase tracking-wider opacity-50 mb-2">Extract Format</label>
                        <select 
                          value={draftSettings.settings.extractFormat || 'BIN/CUE'}
                          onChange={(e) => setDraftSettings((prev: any) => ({ ...prev, settings: { ...prev.settings, extractFormat: e.target.value as 'ISO' | 'BIN/CUE' | 'GDI' } }))}
                          className="w-full bg-transparent border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 theme-select"
                          style={{ borderColor: activeTheme.colors.border, ringColor: activeTheme.colors.accent }}
                        >
                          <option value="BIN/CUE">BIN/CUE (CD)</option>
                          <option value="GDI">GDI (Dreamcast)</option>
                          <option value="ISO">ISO (DVD)</option>
                        </select>
                      </section>
                    )}
                    <section>
                      <label className="block text-xs font-bold uppercase tracking-wider opacity-50 mb-2">
                        Threads: {draftSettings.settings.threads}
                      </label>
                      <input 
                        type="range"
                        min="1"
                        max={maxThreads}
                        step="1"
                        value={draftSettings.settings.threads}
                        onChange={(e) => setDraftSettings((prev: any) => ({ ...prev, settings: { ...prev.settings, threads: parseInt(e.target.value) } }))}
                        className="w-full h-1.5 rounded-lg appearance-none cursor-pointer"
                        style={{ backgroundColor: activeTheme.colors.border }}
                      />
                      <div className="flex justify-between text-[10px] mt-1 opacity-50">
                        {Array.from({ length: maxThreads }, (_, i) => i + 1).map(n => (
                          <span key={n}>
                            {n === 1 || n === maxThreads || n % 4 === 0 ? n : '|'}
                          </span>
                        ))}
                      </div>
                    </section>
                  </>
                ) : draftSettings.type === 'Info' || draftSettings.type === 'Verify' ? null : (
                  <>
                    {/* CSO Compression Level */}
                    <section>
                      <label className="block text-xs font-bold uppercase tracking-wider opacity-50 mb-2">
                        Compression Level: {draftSettings.settings.compressionLevel}
                      </label>
                      <input 
                        type="range"
                        min="1"
                        max="9"
                        step="1"
                        value={draftSettings.settings.compressionLevel}
                        onChange={(e) => setDraftSettings((prev: any) => ({ ...prev, settings: { ...prev.settings, compressionLevel: parseInt(e.target.value) } }))}
                        className="w-full h-1.5 rounded-lg appearance-none cursor-pointer"
                        style={{ backgroundColor: activeTheme.colors.border }}
                      />
                      <div className="flex justify-between text-[10px] mt-1 opacity-50">
                        {[1,2,3,4,5,6,7,8,9].map(n => <span key={n}>{n}</span>)}
                      </div>
                    </section>

                    {/* maxcso Algorithms */}
                    <section>
                      <label className="block text-xs font-bold uppercase tracking-wider opacity-50 mb-2">Compression Algorithms</label>
                      <div className="grid grid-cols-1 gap-2">
                        {MAXCSO_ALGORITHMS.map(algo => {
                          let isEnabled = true;
                          if (draftSettings.type === 'CSO' && algo.type === 'lz4') isEnabled = false;
                          if (draftSettings.type === 'ZSO' && algo.type === 'deflate') isEnabled = false;
                          
                          return (
                            <label 
                              key={algo.id} 
                              className={cn(
                                "flex items-center gap-2 text-sm",
                                isEnabled ? "cursor-pointer" : "opacity-30 cursor-not-allowed"
                              )}
                            >
                              <input 
                                type="checkbox"
                                disabled={!isEnabled}
                                checked={draftSettings.settings.maxcsoAlgorithms.includes(algo.id)}
                                onChange={(e) => {
                                  const current = draftSettings.settings.maxcsoAlgorithms;
                                  const next = e.target.checked 
                                    ? [...current, algo.id]
                                    : current.filter((a: string) => a !== algo.id);
                                  if (next.length > 0) setDraftSettings((prev: any) => ({ ...prev, settings: { ...prev.settings, maxcsoAlgorithms: next } }));
                                }}
                                className="rounded"
                              />
                              {algo.name}
                            </label>
                          );
                        })}
                      </div>
                    </section>

                    <section>
                      <label className="block text-xs font-bold uppercase tracking-wider opacity-50 mb-2">
                        Threads: {draftSettings.settings.threads}
                      </label>
                      <input 
                        type="range"
                        min="1"
                        max={maxThreads}
                        step="1"
                        value={draftSettings.settings.threads}
                        onChange={(e) => setDraftSettings((prev: any) => ({ ...prev, settings: { ...prev.settings, threads: parseInt(e.target.value) } }))}
                        className="w-full h-1.5 rounded-lg appearance-none cursor-pointer"
                        style={{ backgroundColor: activeTheme.colors.border }}
                      />
                      <div className="flex justify-between text-[10px] mt-1 opacity-50">
                        {Array.from({ length: maxThreads }, (_, i) => i + 1).map(n => (
                          <span key={n}>
                            {n === 1 || n === maxThreads || n % 4 === 0 ? n : '|'}
                          </span>
                        ))}
                      </div>
                    </section>
                  </>
                )}

                <div className="pt-4 border-t flex gap-2" style={{ borderColor: activeTheme.colors.border }}>
                  <button 
                    onClick={() => {
                      const settings = draftSettings.settings;
                      const type = draftSettings.type;
                      setJobs(prev => prev.map(j => {
                        if (!selectedJobIds.includes(j.id)) return j;
                        
                        // Keep the target job's fileType unless we explicitly changed it for this job
                        let adaptedSettings = { ...settings };
                        let targetFileType = draftSettings.fileType;
                        
                        if (targetFileType === 'CD' && !CD_HUNK_SIZES.includes(adaptedSettings.hunkSize)) {
                          adaptedSettings.hunkSize = 0;
                        } else if (targetFileType === 'DVD' && !DVD_HUNK_SIZES.includes(adaptedSettings.hunkSize)) {
                          adaptedSettings.hunkSize = 0;
                        }
                        
                        const validAlgos = CHD_ALGORITHMS.filter(a => a.type === targetFileType).map(a => a.id);
                        adaptedSettings.chdAlgorithms = adaptedSettings.chdAlgorithms.filter((a: string) => validAlgos.includes(a));
                        if (adaptedSettings.chdAlgorithms.length === 0) {
                          adaptedSettings.chdAlgorithms = targetFileType === 'CD' ? ['cdzl', 'cdlz', 'cdfl'] : ['zlib', 'lzma', 'huff', 'flac'];
                        }

                        if (adaptedSettings.maxcsoAlgorithms) {
                          const validMaxcsoAlgos = MAXCSO_ALGORITHMS.filter(a => {
                            if (type === 'CSO' && a.type === 'lz4') return false;
                            if (type === 'ZSO' && a.type === 'deflate') return false;
                            return true;
                          }).map(a => a.id);
                          adaptedSettings.maxcsoAlgorithms = adaptedSettings.maxcsoAlgorithms.filter((a: string) => validMaxcsoAlgos.includes(a));
                          if (adaptedSettings.maxcsoAlgorithms.length === 0) {
                            adaptedSettings.maxcsoAlgorithms = type === 'ZSO' ? ['use-lz4', 'use-lz4brute'] : ['use-zlib', 'use-7zdeflate', 'use-libdeflate'];
                          }
                        }

                        return { 
                          ...j, 
                          type,
                          fileType: targetFileType,
                          settings: adaptedSettings,
                          status: 'Pending',
                          progress: 0,
                          downloadUrl: undefined,
                          error: undefined
                        };
                      }));
                      addLog(`Applied settings to ${selectedJobIds.length} selected job(s)`, 'info');
                    }}
                    className="flex-1 py-2 rounded text-sm font-medium border theme-hover"
                    style={{ borderColor: activeTheme.colors.border }}
                  >
                    Apply to Selected
                  </button>
                  <button 
                    onClick={() => {
                      const settings = draftSettings.settings;
                      const type = draftSettings.type;
                      setJobs(prev => prev.map(j => {
                        let adaptedSettings = { ...settings };
                        let targetFileType = draftSettings.fileType;
                        
                        if (targetFileType === 'CD' && !CD_HUNK_SIZES.includes(adaptedSettings.hunkSize)) {
                          adaptedSettings.hunkSize = 0;
                        } else if (targetFileType === 'DVD' && !DVD_HUNK_SIZES.includes(adaptedSettings.hunkSize)) {
                          adaptedSettings.hunkSize = 0;
                        }
                        
                        const validAlgos = CHD_ALGORITHMS.filter(a => a.type === targetFileType).map(a => a.id);
                        adaptedSettings.chdAlgorithms = adaptedSettings.chdAlgorithms.filter((a: string) => validAlgos.includes(a));
                        if (adaptedSettings.chdAlgorithms.length === 0) {
                          adaptedSettings.chdAlgorithms = targetFileType === 'CD' ? ['cdzl', 'cdlz', 'cdfl'] : ['zlib', 'lzma', 'huff', 'flac'];
                        }

                        if (adaptedSettings.maxcsoAlgorithms) {
                          const validMaxcsoAlgos = MAXCSO_ALGORITHMS.filter(a => {
                            if (type === 'CSO' && a.type === 'lz4') return false;
                            if (type === 'ZSO' && a.type === 'deflate') return false;
                            return true;
                          }).map(a => a.id);
                          adaptedSettings.maxcsoAlgorithms = adaptedSettings.maxcsoAlgorithms.filter((a: string) => validMaxcsoAlgos.includes(a));
                          if (adaptedSettings.maxcsoAlgorithms.length === 0) {
                            adaptedSettings.maxcsoAlgorithms = type === 'ZSO' ? ['use-lz4', 'use-lz4brute'] : ['use-zlib', 'use-7zdeflate', 'use-libdeflate'];
                          }
                        }

                        return { 
                          ...j, 
                          type,
                          fileType: targetFileType,
                          settings: adaptedSettings,
                          status: 'Pending',
                          progress: 0,
                          downloadUrl: undefined,
                          error: undefined
                        };
                      }));
                      addLog('Applied format and settings to all jobs and requeued', 'info');
                    }}
                    className="flex-1 py-2 rounded text-sm font-medium border theme-hover"
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
            animate={{ height: consoleHeight }}
            exit={{ height: 0 }}
            transition={{ duration: isDraggingConsole ? 0 : 0.3 }}
            className="border-t flex flex-col overflow-hidden relative"
            style={{ 
              backgroundColor: activeTheme.colors.sidebar, 
              borderColor: activeTheme.colors.border,
              height: consoleHeight
            }}
          >
            {/* Drag Handle */}
            <div 
              className="absolute top-0 left-0 right-0 h-1 cursor-row-resize z-10 hover:bg-black/20"
              onMouseDown={() => setIsDraggingConsole(true)}
            />
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
            <div 
              ref={logContainerRef}
              onScroll={handleLogScroll}
              className="flex-1 overflow-auto p-2 font-mono text-xs space-y-1"
            >
              {logs.filter(log => !logSearchQuery || log.message.toLowerCase().includes(logSearchQuery.toLowerCase())).length === 0 ? (
                <div className="opacity-30 italic">No logs to display</div>
              ) : (
                logs.filter(log => !logSearchQuery || log.message.toLowerCase().includes(logSearchQuery.toLowerCase())).map(log => {
                  const message = log.message.replace(/\r/g, '');
                  let highlightedMessage: React.ReactNode = message;
                  
                  if (logSearchQuery) {
                    // Escape regex special characters
                    const escapedQuery = logSearchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const parts = message.split(new RegExp(`(${escapedQuery})`, 'gi'));
                    highlightedMessage = parts.map((part, i) => 
                      part.toLowerCase() === logSearchQuery.toLowerCase() ? (
                        <span key={i} style={{ backgroundColor: activeTheme.colors.accent, color: activeTheme.colors.accentText }}>{part}</span>
                      ) : part
                    );
                  }

                  return (
                    <div key={log.id} className="flex gap-2 whitespace-pre-wrap break-words">
                      <span className="opacity-30 shrink-0">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                      <span className={cn(
                        log.level === 'error' && "text-red-500",
                        log.level === 'warn' && "text-yellow-500",
                        log.level === 'success' && "text-green-500",
                        log.level === 'info' && "opacity-70"
                      )}>
                        {highlightedMessage}
                      </span>
                    </div>
                  );
                })
              )}
              <div ref={logEndRef} />
            </div>
            
            {/* Log Search */}
            <div 
              className="px-4 py-1.5 flex items-center gap-2 border-t text-xs font-mono"
              style={{ borderColor: activeTheme.colors.border }}
            >
              <Search className="w-3 h-3 opacity-50" />
              <input
                type="text"
                placeholder="Search logs..."
                value={logSearchQuery}
                onChange={(e) => setLogSearchQuery(e.target.value)}
                className="flex-1 bg-transparent border-none outline-none"
                style={{ color: activeTheme.colors.text }}
              />
              {logSearchQuery && (
                <button 
                  onClick={() => setLogSearchQuery('')}
                  className="opacity-50 hover:opacity-100"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
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
            className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-md"
            style={{ backgroundColor: `${activeTheme.colors.bg}80` }}
          >
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-lg p-6 rounded-xl border shadow-2xl max-h-[90vh] overflow-y-auto"
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
                  className="p-1 theme-hover rounded-full"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-6">
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
                        const ipcRenderer = getIpcRenderer();
                        if (ipcRenderer) {
                          const selectedPath = await ipcRenderer.invoke('dialog:openDirectory');
                          if (selectedPath) {
                            setAppSettings(prev => ({ ...prev, outputDirectory: selectedPath }));
                          }
                        } else {
                          addLog('[Web Preview] Directory selection is only available in the desktop app.', 'info');
                          setAppSettings(prev => ({ ...prev, outputDirectory: '/mock/output/directory' }));
                        }
                      }}
                      className="px-4 py-2 rounded text-sm font-medium border theme-hover"
                      style={{ borderColor: activeTheme.colors.border }}
                    >
                      Browse
                    </button>
                  </div>
                  <p className="text-xs opacity-50 mt-1">Absolute path where compressed files will be saved.</p>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Custom chdman Path</label>
                    <div className="flex gap-2">
                      <input 
                        type="text" 
                        value={appSettings.chdmanPath || ''}
                        onChange={(e) => setAppSettings(prev => ({ ...prev, chdmanPath: e.target.value }))}
                        className="flex-1 bg-transparent border rounded px-3 py-2 text-sm"
                        style={{ borderColor: activeTheme.colors.border }}
                        placeholder="Default (system PATH)"
                      />
                      <button
                        onClick={async () => {
                          const ipcRenderer = getIpcRenderer();
                          if (ipcRenderer) {
                            const selectedPath = await ipcRenderer.invoke('dialog:openFile');
                            if (selectedPath) {
                              setAppSettings(prev => ({ ...prev, chdmanPath: selectedPath }));
                            }
                          }
                        }}
                        className="px-4 py-2 rounded text-sm font-medium border theme-hover"
                        style={{ borderColor: activeTheme.colors.border }}
                      >
                        Browse
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1">Custom maxcso Path</label>
                    <div className="flex gap-2">
                      <input 
                        type="text" 
                        value={appSettings.maxcsoPath || ''}
                        onChange={(e) => setAppSettings(prev => ({ ...prev, maxcsoPath: e.target.value }))}
                        className="flex-1 bg-transparent border rounded px-3 py-2 text-sm"
                        style={{ borderColor: activeTheme.colors.border }}
                        placeholder="Default (system PATH)"
                      />
                      <button
                        onClick={async () => {
                          const ipcRenderer = getIpcRenderer();
                          if (ipcRenderer) {
                            const selectedPath = await ipcRenderer.invoke('dialog:openFile');
                            if (selectedPath) {
                              setAppSettings(prev => ({ ...prev, maxcsoPath: selectedPath }));
                            }
                          }
                        }}
                        className="px-4 py-2 rounded text-sm font-medium border theme-hover"
                        style={{ borderColor: activeTheme.colors.border }}
                      >
                        Browse
                      </button>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Default Format</label>
                  <select 
                    value={appSettings.defaultFormat}
                    onChange={(e) => setAppSettings(prev => ({ ...prev, defaultFormat: e.target.value }))}
                    className="w-full bg-transparent border rounded px-3 py-2 text-sm theme-select"
                    style={{ borderColor: activeTheme.colors.border }}
                  >
                    <option value="CHD">CHD (CD/DVD)</option>
                    <option value="CSO">CSO (PSP/PS2)</option>
                    <option value="CSOv2">CSOv2</option>
                    <option value="ZSO">ZSO</option>
                    <option value="Extract">Extract (Decompress)</option>
                    <option value="Info">Info (CHDMAN)</option>
                    <option value="Verify">Verify (CHDMAN)</option>
                  </select>
                </div>

                <div className="space-y-3 pt-2">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={appSettings.deleteOriginals}
                      onChange={(e) => setAppSettings(prev => ({ ...prev, deleteOriginals: e.target.checked }))}
                      className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <div>
                      <div className="text-sm font-medium">Delete Originals on Success</div>
                      <div className="text-xs opacity-50">Automatically delete the source files after successful compression.</div>
                    </div>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={appSettings.autoGenerateM3U}
                      onChange={(e) => setAppSettings(prev => ({ ...prev, autoGenerateM3U: e.target.checked }))}
                      className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <div>
                      <div className="text-sm font-medium">Auto-Generate .m3u Playlists</div>
                      <div className="text-xs opacity-50">Create .m3u files for multi-disc games (e.g., files ending in "Disc 1").</div>
                    </div>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={appSettings.minimizeToTray}
                      onChange={(e) => setAppSettings(prev => ({ ...prev, minimizeToTray: e.target.checked }))}
                      className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <div>
                      <div className="text-sm font-medium">Minimize to System Tray</div>
                      <div className="text-xs opacity-50">Keep the app running in the background when closing the window.</div>
                    </div>
                  </label>
                </div>
              </div>

              <div className="mt-8 flex justify-end gap-3">
                <button 
                  onClick={() => setIsAppSettingsOpen(false)}
                  className="px-4 py-2 rounded text-sm font-medium theme-hover"
                >
                  Cancel
                </button>
                <button 
                  onClick={saveAppSettings}
                  className="px-4 py-2 rounded text-sm font-medium hover:brightness-110"
                  style={{ backgroundColor: activeTheme.colors.accent, color: activeTheme.colors.accentText }}
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
