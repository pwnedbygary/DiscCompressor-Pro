export type JobType = 'CHD' | 'CSO' | 'CSOv2' | 'ZSO' | 'Extract' | 'Info' | 'Verify';
export type JobStatus = 'Pending' | 'Processing' | 'Completed' | 'Error';

export interface CompressionSettings {
  // CHD specific
  hunkSize: number;
  chdAlgorithms: string[];
  
  // CSO/ZSO specific
  compressionLevel: number;
  threads: number;
  maxcsoAlgorithms: string[];

  // Extract specific
  extractFormat?: 'ISO' | 'BIN/CUE';
}

export interface Job {
  id: string;
  fileName: string;
  fileSize: number;
  fileType: 'CD' | 'DVD';
  type: JobType;
  status: JobStatus;
  progress: number;
  settings: CompressionSettings;
  error?: string;
  addedAt: number;
  startTime?: number;
  finalSize?: number;
  file?: File;
  inputPath?: string;
  downloadUrl?: string;
}

export interface Theme {
  name: string;
  id: string;
  colors: {
    bg: string;
    sidebar: string;
    header: string;
    text: string;
    muted: string;
    accent: string;
    accentText: string;
    border: string;
    success: string;
    error: string;
    warning: string;
    info: string;
  };
}

export interface LogEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}
