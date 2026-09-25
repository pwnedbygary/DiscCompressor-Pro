import { describe, expect, it } from 'vitest'
import { Lz4Error, decodeLz4Block } from './lz4'

const block = (...bytes: (number | string)[]): Buffer => Buffer.concat(bytes.map((b) => (typeof b === 'string' ? Buffer.from(b, 'latin1') : Buffer.from([b]))))

describe('decodeLz4Block', () => {
  it('copies literals', () => {
    expect(decodeLz4Block(block(0x50, 'hello'), 64).toString('latin1')).toBe('hello')
  })

  it('copies matches, including ones that overlap what they write', () => {
    // "abc", then 9 bytes from 3 back.
    expect(decodeLz4Block(block(0x35, 'abc', 3, 0), 12).toString('latin1')).toBe('abcabcabcabc')
  })

  it('reads the extra length bytes of long literal runs and matches', () => {
    expect(decodeLz4Block(block(0xf0, 5, 'x'.repeat(20)), 64).toString('latin1')).toBe('x'.repeat(20))
    // 1 literal, then a match of 15 + 255 + 10 + 4 bytes.
    expect(decodeLz4Block(block(0x1f, 'y', 1, 0, 255, 10), 400).toString('latin1')).toBe('y'.repeat(285))
  })

  it('stops once the block is complete, ignoring padding after it', () => {
    expect(decodeLz4Block(Buffer.concat([block(0x40, 'data'), Buffer.alloc(12)]), 4).toString('latin1')).toBe('data')
    expect(decodeLz4Block(block(0x1f, 'z', 1, 0, 255, 10), 100).toString('latin1')).toBe('z'.repeat(100))
  })

  it('rejects damaged blocks', () => {
    expect(() => decodeLz4Block(block(0x50, 'abc'), 64)).toThrow(Lz4Error)
    expect(() => decodeLz4Block(block(0x14, 'a', 0, 0), 64)).toThrow(/before its start/)
    expect(() => decodeLz4Block(block(0x14, 'a', 2, 0), 64)).toThrow(/before its start/)
    expect(() => decodeLz4Block(block(0x10, 'a', 1), 64)).toThrow(/truncated/)
    expect(() => decodeLz4Block(block(0xf0), 64)).toThrow(/truncated/)
  })
})
