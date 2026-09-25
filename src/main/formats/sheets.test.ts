import { describe, expect, it } from 'vitest'
import { parseCue } from './cue'
import { parseGdi } from './gdi'

describe('parseCue', () => {
  it('parses quoted and unquoted file names, modes and INDEX 01', () => {
    const sheet = parseCue(
      '\uFEFFREM GENRE Game\r\nFILE "Game (Track 1).bin" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n' +
        'FILE track02.bin BINARY\n  TRACK 02 AUDIO\n    INDEX 00 00:00:00\n    INDEX 01 00:02:00\n'
    )
    expect(sheet.files).toEqual([
      { name: 'Game (Track 1).bin', type: 'BINARY', tracks: [{ number: 1, mode: 'MODE2/2352', index1: 0 }] },
      { name: 'track02.bin', type: 'BINARY', tracks: [{ number: 2, mode: 'AUDIO', index1: 150 }] }
    ])
  })

  it('is case-insensitive and tolerates unquoted names with spaces', () => {
    const sheet = parseCue('file My Game.iso binary\ntrack 1 mode1/2048\nindex 1 00:00:00')
    expect(sheet.files[0]).toEqual({ name: 'My Game.iso', type: 'BINARY', tracks: [{ number: 1, mode: 'MODE1/2048', index1: 0 }] })
  })

  it('separates an unquoted name from its type by tabs as well as spaces', () => {
    expect(parseCue('FILE My Game.bin\tBINARY\n').files[0]).toMatchObject({ name: 'My Game.bin', type: 'BINARY' })
    expect(parseCue('FILE game.bin  \t MOTOROLA\n').files[0]).toMatchObject({ name: 'game.bin', type: 'MOTOROLA' })
  })

  it('ignores tracks without a file', () => {
    expect(parseCue('TRACK 01 MODE1/2048').files).toEqual([])
  })
})

describe('parseGdi', () => {
  it('parses chdman-style output with quoted names', () => {
    const tracks = parseGdi('3\n1 0 4 2352 "Game 01.bin" 0\n2 756 0 2352 "Game 02.raw" 0\n3 45000 4 2352 "Game 03.bin" 0\n')
    expect(tracks.map((t) => [t.number, t.lba, t.type, t.sectorSize, t.file, t.offset])).toEqual([
      [1, 0, 4, 2352, 'Game 01.bin', 0],
      [2, 756, 0, 2352, 'Game 02.raw', 0],
      [3, 45000, 4, 2352, 'Game 03.bin', 0]
    ])
  })

  it('accepts unquoted names with spaces', () => {
    const [track] = parseGdi('1\r\n1 0 4 2048 track one.bin 0\r\n')
    expect(track?.file).toBe('track one.bin')
  })

  it('rejects a mismatched track count', () => {
    expect(() => parseGdi('2\n1 0 4 2352 track01.bin 0\n')).toThrow(/lists 2 tracks/)
    expect(() => parseGdi('hello')).toThrow(/track count/)
  })
})
