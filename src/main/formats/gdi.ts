export interface GdiTrack {
  number: number
  lba: number
  /** 0 for audio, 4 for data. */
  type: number
  sectorSize: number
  file: string
  offset: number
}

function tokenize(line: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"]*)"|(\S+)/g
  for (const match of line.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? '')
  return tokens
}

/**
 * Parse a Dreamcast GDI sheet: a track count followed by lines of
 * `track lba type sector_size filename offset`. Filenames containing spaces
 * are normally quoted; unquoted ones are tolerated as well.
 */
export function parseGdi(text: string): GdiTrack[] {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const count = Number.parseInt(lines[0] ?? '', 10)
  if (!Number.isInteger(count) || count < 1 || count > 99) throw new Error('Not a valid GDI file (bad track count)')

  const tracks: GdiTrack[] = []
  for (const line of lines.slice(1)) {
    const tokens = tokenize(line)
    if (tokens.length < 6) continue
    const [number, lba, type, sectorSize] = tokens.slice(0, 4).map((token) => Number.parseInt(token, 10))
    const offset = Number.parseInt(tokens.at(-1) ?? '', 10)
    const file = tokens.slice(4, -1).join(' ')
    if ([number, lba, type, sectorSize, offset].some((value) => value === undefined || Number.isNaN(value))) continue
    tracks.push({
      number: number as number,
      lba: lba as number,
      type: type as number,
      sectorSize: sectorSize as number,
      file,
      offset
    })
  }
  if (tracks.length !== count) throw new Error(`GDI file lists ${count} tracks but ${tracks.length} could be read`)
  return tracks
}
