export interface CueTrack {
  number: number
  /** Mode exactly as written, upper-cased, e.g. MODE2/2352 or AUDIO. */
  mode: string
  /** Offset of INDEX 01 within the file, in 1/75 s frames. */
  index1: number | null
}

export interface CueFile {
  name: string
  type: string
  tracks: CueTrack[]
}

export interface CueSheet {
  files: CueFile[]
}

function unquote(value: string): string {
  const trimmed = value.trim()
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed
}

function parseMsf(value: string): number | null {
  const match = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const [, m, s, f] = match
  return (Number(m) * 60 + Number(s)) * 75 + Number(f)
}

/** Parse a CDRWIN cue sheet, keeping only what is needed to locate and classify tracks. */
export function parseCue(text: string): CueSheet {
  const files: CueFile[] = []
  let currentTrack: CueTrack | null = null

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const line = rawLine.trim()
    const space = line.search(/\s/)
    if (space < 0) continue
    const command = line.slice(0, space).toUpperCase()
    const rest = line.slice(space + 1).trim()

    if (command === 'FILE') {
      let name: string
      let type: string
      if (rest.startsWith('"')) {
        const end = rest.indexOf('"', 1)
        if (end < 0) continue
        name = rest.slice(1, end)
        type = rest.slice(end + 1).trim()
      } else {
        // An unquoted name runs up to the whitespace (spaces or tabs) before the file type.
        const match = /^(.*\S)\s+(\S+)$/.exec(rest)
        name = match?.[1] ?? rest
        type = match?.[2] ?? ''
      }
      files.push({ name: unquote(name), type: type.toUpperCase(), tracks: [] })
      currentTrack = null
    } else if (command === 'TRACK') {
      const file = files.at(-1)
      const [number, mode] = rest.split(/\s+/)
      if (!file || !number || !mode) continue
      currentTrack = { number: Number.parseInt(number, 10), mode: mode.toUpperCase(), index1: null }
      file.tracks.push(currentTrack)
    } else if (command === 'INDEX' && currentTrack) {
      const [number, time] = rest.split(/\s+/)
      if (number && Number.parseInt(number, 10) === 1 && time) currentTrack.index1 = parseMsf(time)
    }
  }

  return { files }
}
