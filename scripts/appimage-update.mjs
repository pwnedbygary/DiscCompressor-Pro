/**
 * The update information that AppImageUpdate, GearLever and other AppImage
 * tools read from the AppImage: where to find the .zsync file of its latest
 * version. It lives in the runtime's .upd_info section, which
 * appimage-tools.mjs fills in before electron-builder puts the runtime at the
 * start of the AppImage; appimage-zsync.mjs writes the .zsync files.
 */
import { readFileSync } from 'node:fs'
import { open, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The GitHub repository the app is published from, taken from package.json's homepage. */
function repository() {
  const { homepage } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/.exec(homepage ?? '')
  if (!match) throw new Error(`package.json's homepage is not a GitHub repository: ${homepage}`)
  return { owner: match[1], repo: match[2] }
}

const { owner, repo } = repository()

/** The .zsync file of the latest release's x86-64 AppImage, named like electron-builder.yml's linux.artifactName. */
export const UPDATE_INFORMATION = `gh-releases-zsync|${owner}|${repo}|latest|DiscCompressorPro-*-x86_64.AppImage.zsync`

/** The file offset and size of an ELF file's section named `name`. */
function findSection(data, name) {
  if (data.readUInt32BE(0) !== 0x7f454c46) throw new Error('Not an ELF file')
  const is64 = data[4] === 2
  const little = data[5] === 1
  const u16 = (offset) => (little ? data.readUInt16LE(offset) : data.readUInt16BE(offset))
  const u32 = (offset) => (little ? data.readUInt32LE(offset) : data.readUInt32BE(offset))
  const word = (offset) => (is64 ? Number(little ? data.readBigUInt64LE(offset) : data.readBigUInt64BE(offset)) : u32(offset))
  const tableOffset = word(is64 ? 0x28 : 0x20)
  const entrySize = u16(is64 ? 0x3a : 0x2e)
  const count = u16(is64 ? 0x3c : 0x30)
  const namesIndex = u16(is64 ? 0x3e : 0x32)
  const header = (index) => {
    const at = tableOffset + index * entrySize
    return { name: u32(at), offset: word(at + (is64 ? 0x18 : 0x10)), size: word(at + (is64 ? 0x20 : 0x14)) }
  }
  const names = header(namesIndex)
  for (let index = 0; index < count; index += 1) {
    const section = header(index)
    const start = names.offset + section.name
    if (data.toString('latin1', start, data.indexOf(0, start)) === name) return section
  }
  throw new Error(`No ${name} section`)
}

/** The runtime at the start of an AppImage, its section headers included, is about 1 MB. */
const HEAD_BYTES = 4 * 1024 * 1024

/** The update information stored in an AppImage or runtime, '' if there is none. */
export async function readUpdateInformation(path) {
  const file = await open(path, 'r')
  let data
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await file.read(buffer, 0, HEAD_BYTES, 0)
    data = buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
  const { offset, size } = findSection(data, '.upd_info')
  const field = data.subarray(offset, offset + size)
  const end = field.indexOf(0)
  return field.toString('utf8', 0, end < 0 ? size : end)
}

/** Store `text` as the update information of an AppImage runtime. */
export async function writeUpdateInformation(path, text) {
  const data = await readFile(path)
  const { offset, size } = findSection(data, '.upd_info')
  const bytes = Buffer.from(text, 'utf8')
  // The field is read up to its first zero byte, so one must remain.
  if (bytes.length >= size) throw new Error(`The update information does not fit the ${size}-byte .upd_info section`)
  data.fill(0, offset, offset + size)
  bytes.copy(data, offset)
  await writeFile(path, data)
}
