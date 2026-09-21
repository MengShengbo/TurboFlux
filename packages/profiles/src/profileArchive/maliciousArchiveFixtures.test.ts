import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJsonBytes } from './canonicalJson'
import { verifyProfileArchiveContainer } from './container'
import { PROFILE_ARCHIVE_CONTAINER_VERSION, PROFILE_ARCHIVE_MAGIC } from './types'

const roots: string[] = []
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest()

function rawArchive(entries: Array<{ path: string | Uint8Array; data: Uint8Array; digest?: Uint8Array; declaredSize?: number }>): string {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-malicious-'))
  roots.push(root)
  const frames: Buffer[] = []
  for (const entry of entries) {
    const path = typeof entry.path === 'string' ? Buffer.from(entry.path, 'utf8') : Buffer.from(entry.path)
    const data = Buffer.from(entry.data)
    const header = Buffer.alloc(44)
    header.writeUInt32BE(path.length, 0)
    header.writeBigUInt64BE(BigInt(entry.declaredSize ?? data.length), 4)
    Buffer.from(entry.digest ?? sha256(data)).copy(header, 12)
    frames.push(header, path, data)
  }
  frames.push(Buffer.alloc(4))
  const payload = gzipSync(Buffer.concat(frames))
  const header = canonicalJsonBytes({ containerVersion: 1, compression: 'gzip', encrypted: false })
  const prelude = Buffer.alloc(32)
  prelude.write(PROFILE_ARCHIVE_MAGIC, 0, 'ascii')
  prelude.writeUInt16BE(PROFILE_ARCHIVE_CONTAINER_VERSION, 16)
  prelude.writeUInt32BE(header.length, 20)
  prelude.writeBigUInt64BE(BigInt(payload.length), 24)
  const path = join(root, 'fixture.turboflux-profile')
  writeFileSync(path, Buffer.concat([prelude, header, payload, sha256(payload)]))
  return path
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('malicious profile archive fixtures', () => {
  it.each([
    '../escape', 'items/%2e%2e/escape', 'C:/escape', '//server/share', 'items/CON.json', 'items/name.',
  ])('fails closed for framed path %j', async path => {
    await expect(verifyProfileArchiveContainer({ path: rawArchive([{ path, data: Buffer.alloc(0) }]) }))
      .rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE_ENTRY' })
  })

  it.each([
    ['duplicate manifest', ['manifest.json', 'manifest.json']],
    ['case collision', ['Items/A.json', 'items/a.json']],
    ['Unicode collision', ['items/é.json', 'items/e\u0301.json']],
  ])('fails closed for %s', async (_label, paths) => {
    await expect(verifyProfileArchiveContainer({
      path: rawArchive(paths.map(path => ({ path, data: Buffer.from('{}') }))),
    })).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE_ENTRY' })
  })

  it('rejects incorrect digests and truncated framed content', async () => {
    await expect(verifyProfileArchiveContainer({
      path: rawArchive([{ path: 'manifest.json', data: Buffer.from('{}'), digest: Buffer.alloc(32) }]),
    })).rejects.toMatchObject({ code: 'ARCHIVE_CORRUPT' })
    await expect(verifyProfileArchiveContainer({
      path: rawArchive([{ path: 'manifest.json', data: Buffer.from('{}'), declaredSize: 100 }]),
    })).rejects.toMatchObject({ code: 'ARCHIVE_CORRUPT' })
  })

  it('rejects entry paths that are not strict UTF-8', async () => {
    await expect(verifyProfileArchiveContainer({
      path: rawArchive([{ path: Uint8Array.from([0xff, 0xfe]), data: Buffer.alloc(0) }]),
    })).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE_ENTRY' })
  })

  it('stops decompression bombs and excessive entries before materialization', async () => {
    const mixed = Buffer.concat([Buffer.alloc(512 * 1024), randomBytes(512 * 1024)])
    await expect(verifyProfileArchiveContainer({
      path: rawArchive([{ path: 'blobs/sha256/data', data: mixed }]),
      limits: { maxCompressionRatio: 1.2 },
    })).rejects.toMatchObject({ code: 'ARCHIVE_RESOURCE_LIMIT' })
    await expect(verifyProfileArchiveContainer({
      path: rawArchive([
        { path: 'one.json', data: Buffer.from('{}') },
        { path: 'two.json', data: Buffer.from('{}') },
      ]),
      limits: { maxEntries: 1 },
    })).rejects.toMatchObject({ code: 'ARCHIVE_RESOURCE_LIMIT' })
  })
})
