const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1)
  const value = bytes / 1024 ** exponent
  const digits = exponent === 0 || value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${BYTE_UNITS[exponent]}`
}

export function formatNumber(value: number): string {
  return value.toLocaleString()
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function formatPercent(fraction: number): string {
  return `${Math.floor(Math.min(Math.max(fraction, 0), 1) * 100)}%`
}

/** A size reduction to one decimal, rounded down so that 99.97% never reads as 100%. */
export function formatReduction(fraction: number): string {
  return `${(Math.floor(Math.min(Math.max(fraction, 0), 1) * 1000) / 10).toFixed(1)}%`
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** Estimated time left from elapsed time and progress, once there is enough data to be meaningful. */
export function estimateRemaining(startedAt: number | null, progress: number | null, now = Date.now()): number | null {
  if (!startedAt || progress === null || progress < 0.02 || progress >= 1) return null
  const elapsed = now - startedAt
  if (elapsed < 3000) return null
  return (elapsed / progress) * (1 - progress)
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** Shorten a path for display by replacing the home directory with ~. */
export function displayPath(path: string, homeDir: string | undefined): string {
  if (homeDir && (path === homeDir || path.startsWith(homeDir + '/') || path.startsWith(homeDir + '\\'))) {
    return `~${path.slice(homeDir.length)}`
  }
  return path
}
