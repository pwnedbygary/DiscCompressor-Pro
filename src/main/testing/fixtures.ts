import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const tagValue = (name: string): number => name.split('').reduce((value, char) => (value << 8) | char.charCodeAt(0), 0) >>> 0

/** A minimal CHD v5 file: a header followed by the given metadata entries. */
export function syntheticChd(options: { codecs: string[]; hunk: number; unit: number; logical: number; metadata: [string, string][] }): Buffer {
  const header = Buffer.alloc(124)
  header.write('MComprHD', 0, 'latin1')
  header.writeUInt32BE(124, 8)
  header.writeUInt32BE(5, 12)
  options.codecs.forEach((codec, i) => header.writeUInt32BE(tagValue(codec), 16 + i * 4))
  header.writeBigUInt64BE(BigInt(options.logical), 32)
  header.writeBigUInt64BE(BigInt(options.metadata.length > 0 ? 124 : 0), 48)
  header.writeUInt32BE(options.hunk, 56)
  header.writeUInt32BE(options.unit, 60)

  const entries: Buffer[] = []
  let offset = 124
  options.metadata.forEach(([tag, text], index) => {
    const data = Buffer.from(`${text}\0`, 'latin1')
    const entry = Buffer.alloc(16)
    entry.writeUInt32BE(tagValue(tag), 0)
    entry.writeUInt8(1, 4)
    entry.writeUIntBE(data.length, 5, 3)
    const next = index === options.metadata.length - 1 ? 0 : offset + 16 + data.length
    entry.writeBigUInt64BE(BigInt(next), 8)
    entries.push(entry, data)
    offset += 16 + data.length
  })
  return Buffer.concat([header, ...entries])
}

export function syntheticCso(uncompressedBytes: number, magic: 'CISO' | 'ZISO' = 'CISO', version = 1): Buffer {
  const header = Buffer.alloc(64)
  header.write(magic, 0, 'latin1')
  header.writeUInt32LE(24, 4)
  header.writeBigUInt64LE(BigInt(uncompressedBytes), 8)
  header.writeUInt32LE(2048, 16)
  header.writeUInt8(version, 20)
  return header
}

// Stand-ins for chdman and maxcso that follow their command-line contracts
// closely enough to exercise the runner: output files, progress on stderr,
// failures and long-running work that can be cancelled.
const FAKE_CHDMAN = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const [command, ...rest] = process.argv.slice(2)
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined }
const input = opt('-i')
console.log('chdman - MAME Compressed Hunks of Data (CHD) manager 0.289 (mame0289)')
if (input && input.includes('fail')) { console.error('Error: simulated failure'); process.exit(1) }
const progress = (verb) => { for (const p of [25, 50, 75]) process.stderr.write(verb + ', ' + p + '.0% complete... \\r') }
const finish = () => {
  if (input && input.includes('slow')) setTimeout(() => {}, 60000)
}
switch (command) {
  case 'createcd': case 'createdvd': case 'copy':
    progress('Compressing'); fs.writeFileSync(opt('-o'), 'CHD:' + command + ':' + rest.join(' '))
    process.stderr.write('Compression complete ... final ratio = 50.0%\\n'); finish(); break
  case 'extractdvd':
    progress('Extracting'); fs.writeFileSync(opt('-o'), Buffer.alloc(4096)); finish(); break
  case 'extractcd': {
    // Track names follow chdman 0.289: GDI and GD-ROM cue sheets get one file per track.
    const out = opt('-o'); const base = out.replace(/\\.(cue|gdi)$/, '')
    const meta = fs.readFileSync(input, 'latin1')
    const tracks = [...meta.matchAll(/TRACK:(\\d+) TYPE:(\\S+)/g)].map((m) => m[2])
    const gdi = out.endsWith('.gdi')
    const split = gdi || meta.includes('CHGD')
    const pad = (n) => String(n).padStart(gdi || tracks.length >= 10 ? 2 : 1, '0')
    const bins = split
      ? tracks.map((type, i) => gdi ? base + pad(i + 1) + (type === 'AUDIO' ? '.raw' : '.bin') : base + ' (Track ' + pad(i + 1) + ').bin')
      : [opt('-ob') || base + '.bin']
    progress('Extracting')
    for (const bin of bins) fs.writeFileSync(bin, Buffer.alloc(2048 * 4, 1))
    fs.writeFileSync(out, bins.map((bin) => 'FILE "' + path.basename(bin) + '" BINARY\\n  TRACK 01 MODE1/2048\\n    INDEX 01 00:00:00\\n').join(''))
    console.log('Extraction complete'); finish(); break
  }
  case 'info': console.log('File Version: 5'); console.log('Logical size: 4,096 bytes'); break
  case 'verify':
    // Like chdman, a bad checksum or a CHD that cannot be checked still exits with 0.
    if (input.includes('uncompressed')) { console.error('No verification to be done; CHD is uncompressed'); console.error('Fatal error occurred: 0'); break }
    progress('Verifying')
    if (input.includes('badsha')) { console.error('Error: Raw SHA1 in header = 0123'); console.error('              actual SHA1 = 4567'); break }
    console.log('Raw SHA1 verification successful!')
    console.log('Overall SHA1 verification successful!')
    break
  default: console.error('Unknown command ' + command); process.exit(1)
}
`

const FAKE_MAXCSO = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === '--version') { console.error('maxcso v1.13.0'); process.exit(1) }
const out = args[args.indexOf('-o') + 1]
const input = args[args.length - 1]
// "brokencso" fails in maxcso only, so a chdman job on the same image can succeed.
if (input.includes('fail') || input.includes('brokencso')) { console.error('Error while processing ' + input + ': simulated failure'); process.exit(1) }
const data = fs.readFileSync(input)
fs.writeFileSync(out, args.includes('--decompress') ? Buffer.alloc(8192) : Buffer.concat([Buffer.from('CISO'), data.subarray(0, 16), Buffer.from(args.join(' '))]))
// "waitcso" keeps only maxcso busy, so a chdman job on the same image can finish first.
if (input.includes('slow') || input.includes('waitcso')) setTimeout(() => {}, 60000)
`

export async function writeFakeTools(dir: string): Promise<{ chdman: string; maxcso: string }> {
  const chdman = join(dir, 'chdman')
  const maxcso = join(dir, 'maxcso')
  await writeFile(chdman, FAKE_CHDMAN)
  await writeFile(maxcso, FAKE_MAXCSO)
  await chmod(chdman, 0o755)
  await chmod(maxcso, 0o755)
  return { chdman, maxcso }
}
