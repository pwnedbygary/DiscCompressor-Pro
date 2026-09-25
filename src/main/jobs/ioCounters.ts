import { readFile } from 'node:fs/promises'

/*
 * maxcso only prints progress when stderr is a terminal, so its progress is
 * measured from the outside as the number of bytes the process has read:
 * /proc/<pid>/io on Linux, GetProcessIoCounters on Windows.
 */

interface WindowsApi {
  OpenProcess: (access: number, inherit: number, pid: number) => unknown
  GetProcessIoCounters: (handle: unknown, counters: Record<string, unknown>) => number
  CloseHandle: (handle: unknown) => number
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
let windowsApi: Promise<WindowsApi | null> | undefined

function loadWindowsApi(): Promise<WindowsApi | null> {
  windowsApi ??= import('koffi')
    .then(({ default: koffi }) => {
      const kernel32 = koffi.load('kernel32.dll')
      koffi.struct('IO_COUNTERS', {
        ReadOperationCount: 'uint64',
        WriteOperationCount: 'uint64',
        OtherOperationCount: 'uint64',
        ReadTransferCount: 'uint64',
        WriteTransferCount: 'uint64',
        OtherTransferCount: 'uint64'
      })
      const api: WindowsApi = {
        OpenProcess: kernel32.func('void *__stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
        GetProcessIoCounters: kernel32.func('int __stdcall GetProcessIoCounters(void *process, _Out_ IO_COUNTERS *counters)'),
        CloseHandle: kernel32.func('int __stdcall CloseHandle(void *handle)')
      }
      return api
    })
    .catch((error: unknown) => {
      console.warn('Process I/O counters are unavailable; maxcso progress will be indeterminate.', error)
      return null
    })
  return windowsApi
}

async function windowsBytesRead(pid: number): Promise<number | null> {
  const api = await loadWindowsApi()
  if (!api) return null
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (!handle) return null
  try {
    const counters: Record<string, unknown> = {}
    if (!api.GetProcessIoCounters(handle, counters)) return null
    return Number(counters.ReadTransferCount)
  } finally {
    api.CloseHandle(handle)
  }
}

async function linuxBytesRead(pid: number): Promise<number | null> {
  try {
    const match = /^rchar:\s*(\d+)$/m.exec(await readFile(`/proc/${pid}/io`, 'utf8'))
    return match?.[1] ? Number(match[1]) : null
  } catch {
    return null
  }
}

/** Total bytes a running process has read so far, or null if that cannot be measured. */
export function processBytesRead(pid: number): Promise<number | null> {
  if (process.platform === 'linux') return linuxBytesRead(pid)
  if (process.platform === 'win32') return windowsBytesRead(pid)
  return Promise.resolve(null)
}
