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

export interface IsoEntry {
  name: string
  /** A file's contents; a directory has entries instead. */
  data?: Buffer
  entries?: IsoEntry[]
}

/** An ISO 9660 directory record; the name "\0" is the directory itself and "\1" its parent. */
export function directoryRecord(name: Buffer, lba: number, bytes: number, directory: boolean): Buffer {
  const record = Buffer.alloc(33 + name.length + (name.length % 2 === 0 ? 1 : 0))
  record[0] = record.length
  record.writeUInt32LE(lba, 2)
  record.writeUInt32BE(lba, 6)
  record.writeUInt32LE(bytes, 10)
  record.writeUInt32BE(bytes, 14)
  record[25] = directory ? 2 : 0
  record.writeUInt16LE(1, 28)
  record.writeUInt16BE(1, 30)
  record[32] = name.length
  name.copy(record, 33)
  return record
}

/**
 * A small ISO 9660 image: volume descriptors at sector 16 (with a UDF volume
 * recognition sequence after them if asked), the root directory at sector 24
 * and the files and directories after it, padded with zeros to `sectors`.
 * `bigEndianRootLength` overrides the big-endian copy of the root directory's
 * length in the volume descriptor.
 */
export function syntheticIso(options: { systemId?: string; entries?: IsoEntry[]; udf?: boolean; sectors?: number; bigEndianRootLength?: number } = {}): Buffer {
  const sectors: Buffer[] = []
  const put = (lba: number, data: Buffer): void => {
    for (let i = 0; i * 2048 < Math.max(data.length, 1); i += 1) sectors[lba + i] = Buffer.concat([data.subarray(i * 2048, (i + 1) * 2048)], 2048)
  }
  const record = directoryRecord
  let next = 25
  const directory = (entries: IsoEntry[], lba: number, parent: number): void => {
    const records = [record(Buffer.from([0]), lba, 2048, true), record(Buffer.from([1]), parent, 2048, true)]
    for (const entry of entries) {
      const start = next
      if (entry.entries) {
        next += 1
        records.push(record(Buffer.from(entry.name, 'latin1'), start, 2048, true))
        directory(entry.entries, start, lba)
      } else {
        const data = entry.data ?? Buffer.alloc(0)
        next += Math.max(1, Math.ceil(data.length / 2048))
        records.push(record(Buffer.from(`${entry.name};1`, 'latin1'), start, data.length, false))
        put(start, data)
      }
    }
    put(lba, Buffer.concat(records))
  }
  directory(options.entries ?? [], 24, 24)

  const pvd = Buffer.alloc(2048)
  pvd[0] = 1
  pvd.write('CD001', 1, 'latin1')
  pvd[6] = 1
  pvd.write((options.systemId ?? '').padEnd(32, ' '), 8, 'latin1')
  pvd.write('TEST'.padEnd(32, ' '), 40, 'latin1')
  const total = Math.max(options.sectors ?? 0, next)
  pvd.writeUInt32LE(total, 80)
  pvd.writeUInt32BE(total, 84)
  pvd.writeUInt16LE(2048, 128)
  pvd.writeUInt16BE(2048, 130)
  record(Buffer.from([0]), 24, 2048, true).copy(pvd, 156)
  if (options.bigEndianRootLength !== undefined) pvd.writeUInt32BE(options.bigEndianRootLength, 156 + 14)
  pvd[881] = 1
  put(16, pvd)
  const descriptor = (type: number, id: string): Buffer => {
    const sector = Buffer.alloc(2048)
    sector[0] = type
    sector.write(id, 1, 'latin1')
    sector[6] = 1
    return sector
  }
  put(17, descriptor(255, 'CD001'))
  if (options.udf) {
    put(18, descriptor(0, 'BEA01'))
    put(19, descriptor(0, 'NSR02'))
    put(20, descriptor(0, 'TEA01'))
  }
  return Buffer.concat(Array.from({ length: total }, (_, i) => sectors[i] ?? Buffer.alloc(2048)))
}

/** A CSO v1 file holding `image` in 2048-byte blocks, all stored uncompressed. */
export function storedCso(image: Buffer): Buffer {
  const blocks = Math.ceil(image.length / 2048)
  const header = syntheticCso(image.length).subarray(0, 24)
  const index = Buffer.alloc((blocks + 1) * 4)
  const start = 24 + index.length
  for (let i = 0; i <= blocks; i += 1) index.writeUInt32LE((start + Math.min(i * 2048, image.length) + (i < blocks ? 0x80000000 : 0)) >>> 0, i * 4)
  return Buffer.concat([header, index, image])
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
