export class Lz4Error extends Error {}

/**
 * Decode an LZ4 block (the raw block format, without a frame) into at most
 * `size` bytes. Decoding stops once `size` bytes are written, as the blocks of
 * CSO and ZSO images may be followed by padding. Returns the bytes written.
 */
export function decodeLz4Block(input: Buffer, size: number): Buffer {
  const output = Buffer.alloc(size)
  let ip = 0
  let op = 0
  const length = (initial: number): number => {
    let total = initial
    if (initial !== 15) return total
    for (;;) {
      if (ip >= input.length) throw new Lz4Error('The LZ4 block is truncated')
      const byte = input[ip++] as number
      total += byte
      if (byte !== 255) return total
    }
  }
  while (ip < input.length && op < size) {
    const token = input[ip++] as number
    const literals = length(token >> 4)
    if (ip + literals > input.length) throw new Lz4Error('The LZ4 block is truncated')
    const copied = Math.min(literals, size - op)
    input.copy(output, op, ip, ip + copied)
    ip += literals
    op += copied
    // The last sequence has literals only.
    if (op >= size || ip >= input.length) break
    if (ip + 2 > input.length) throw new Lz4Error('The LZ4 block is truncated')
    const offset = input.readUInt16LE(ip)
    ip += 2
    if (offset === 0 || offset > op) throw new Lz4Error('The LZ4 block refers to data before its start')
    const end = Math.min(op + length(token & 15) + 4, size)
    // Matches may overlap what they write, so they are copied byte by byte.
    for (let from = op - offset; op < end; from += 1, op += 1) output[op] = output[from] as number
  }
  return output.subarray(0, op)
}
