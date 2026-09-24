import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export interface ToolExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface RunningTool {
  pid: number | undefined
  exited: Promise<ToolExit>
  /** Ask the tool to stop, killing it outright if it is still running after a grace period (or at once with `force`). */
  kill(force?: boolean): void
}

const KILL_GRACE_MS = 5000

/** Splits a byte stream into lines; chdman ends progress updates with a bare CR. */
export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8')
  private pending = ''

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer): void {
    this.emit(this.pending + this.decoder.write(chunk))
  }

  end(): void {
    const rest = this.pending + this.decoder.end()
    this.pending = ''
    if (rest.trim()) this.onLine(rest.trim())
  }

  private emit(text: string): void {
    const parts = text.split(/\r\n|\r|\n/)
    this.pending = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.trim()
      if (line) this.onLine(line)
    }
  }
}

/**
 * Spawn a command-line tool without a shell (arguments are passed verbatim,
 * so file names can never be interpreted as shell syntax) and without a
 * console window on Windows.
 */
export function startTool(
  executable: string,
  args: string[],
  onLine: (line: string, stream: 'stdout' | 'stderr') => void,
  env: NodeJS.ProcessEnv = process.env
): RunningTool {
  const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
  const stdout = new LineSplitter((line) => onLine(line, 'stdout'))
  const stderr = new LineSplitter((line) => onLine(line, 'stderr'))
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))

  let forceKill: NodeJS.Timeout | undefined
  const exited = new Promise<ToolExit>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      clearTimeout(forceKill)
      stdout.end()
      stderr.end()
      resolve({ code, signal })
    })
  })

  return {
    pid: child.pid,
    exited,
    kill(force = false) {
      if (child.exitCode !== null || child.signalCode !== null) return
      if (force) {
        child.kill('SIGKILL')
        return
      }
      child.kill()
      forceKill ??= setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
    }
  }
}

/** Render a command line for the log, quoting arguments that need it. */
export function formatCommand(executable: string, args: string[]): string {
  const quote = (value: string): string => (/^[\w./:=,@+-]+$/.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`)
  return [executable, ...args].map(quote).join(' ')
}
