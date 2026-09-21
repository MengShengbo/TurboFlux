import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectProfileArchiveEntries, inspectProfileArchiveEnvelope, verifyProfileArchiveContainer, writeProfileArchive } from './container'
import { ProfileArchiveError } from './types'

const directories: string[] = []
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'turboflux-archive-'))
  directories.push(path)
  return path
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('profile archive streaming container', () => {
  it('round trips inline and streamed files without duplicate content buffering', async () => {
    const root = directory()
    const blobPath = join(root, 'blob.bin')
    const blob = randomBytes(2 * 1024 * 1024)
    const blobDigest = digest(blob)
    writeFileSync(blobPath, blob)
    const targetPath = join(root, 'profile.turboflux-profile')
    const result = await writeProfileArchive({
      targetPath,
      entries: [
        { path: 'manifest.json', data: '{"ok":true}', size: 11, digest: digest('{"ok":true}') },
        { path: `blobs/sha256/${blobDigest}`, sourcePath: blobPath, sourceMtimeMs: 0, size: blob.length, digest: blobDigest },
      ].map(entry => entry.sourcePath ? { ...entry, sourceMtimeMs: undefined } : entry),
    })
    expect(result.encrypted).toBe(false)
    expect(await inspectProfileArchiveEnvelope(targetPath)).toMatchObject({ encrypted: false, containerVersion: 1 })
    const entries = await collectProfileArchiveEntries({ path: targetPath, maxCollectedBytes: 3 * 1024 * 1024 })
    expect(entries.get('manifest.json')?.toString('utf8')).toBe('{"ok":true}')
    expect(entries.get(`blobs/sha256/${blobDigest}`)?.equals(blob)).toBe(true)
  })

  it('authenticates encrypted archives and hides entry names from the fixed header', async () => {
    const root = directory()
    const targetPath = join(root, 'private.turboflux-profile')
    await writeProfileArchive({
      targetPath,
      password: 'correct horse battery staple',
      entries: [{ path: 'components/credentials/credentials.json', data: 'super-secret-value', size: 18, digest: digest('super-secret-value') }],
    })
    expect(await inspectProfileArchiveEnvelope(targetPath)).toMatchObject({ encrypted: true })
    expect(readFileSync(targetPath).subarray(0, 512).toString('utf8')).not.toContain('credentials')
    await expect(verifyProfileArchiveContainer({ path: targetPath, password: 'wrong password' })).rejects.toMatchObject({ code: 'ARCHIVE_AUTHENTICATION_FAILED' })
    const entries = await collectProfileArchiveEntries({ path: targetPath, password: 'correct horse battery staple' })
    expect(entries.values().next().value?.toString('utf8')).toBe('super-secret-value')

    const tampered = readFileSync(targetPath)
    const payloadOffset = 32 + tampered.readUInt32BE(20)
    tampered[payloadOffset + 2] = tampered[payloadOffset + 2]! ^ 0xff
    writeFileSync(targetPath, tampered)
    await expect(verifyProfileArchiveContainer({ path: targetPath, password: 'correct horse battery staple' })).rejects.toMatchObject({ code: 'ARCHIVE_AUTHENTICATION_FAILED' })
  })

  it('rejects unsafe paths and never overwrites an existing target', async () => {
    const root = directory()
    const targetPath = join(root, 'existing.turboflux-profile')
    writeFileSync(targetPath, 'keep')
    await expect(writeProfileArchive({ targetPath, entries: [] })).rejects.toMatchObject({ code: 'ARCHIVE_TARGET_EXISTS' })
    await expect(writeProfileArchive({
      targetPath: join(root, 'unsafe.turboflux-profile'),
      entries: [{ path: '../escape', data: '', size: 0, digest: digest('') }],
    })).rejects.toBeInstanceOf(ProfileArchiveError)
    for (const unsafePath of ['C:/escape', '//server/share', 'items/%2e%2e/escape', 'items/CON.json', 'items/name.']) {
      await expect(writeProfileArchive({
        targetPath: join(root, `${digest(unsafePath)}.turboflux-profile`),
        entries: [{ path: unsafePath, data: '', size: 0, digest: digest('') }],
      })).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE_ENTRY' })
    }
    await expect(writeProfileArchive({
      targetPath: join(root, 'case-collision.turboflux-profile'),
      entries: [
        { path: 'Items/A.json', data: '', size: 0, digest: digest('') },
        { path: 'items/a.json', data: '', size: 0, digest: digest('') },
      ],
    })).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE_ENTRY' })
    expect(readFileSync(targetPath, 'utf8')).toBe('keep')
  })

  it('fails before staging when available disk space is insufficient', async () => {
    const root = directory()
    const targetPath = join(root, 'no-space.turboflux-profile')
    await expect(writeProfileArchive({
      targetPath,
      availableBytes: async () => 1,
      entries: [{ path: 'manifest.json', data: '{}', size: 2, digest: digest('{}') }],
    })).rejects.toMatchObject({ code: 'ARCHIVE_DISK_SPACE_LOW' })
    expect(() => readFileSync(targetPath)).toThrow()
  })

  it('removes staging output when a snapshotted Blob changes before serialization', async () => {
    const root = directory()
    const sourcePath = join(root, 'changing.bin')
    writeFileSync(sourcePath, 'before')
    const snapshot = statSync(sourcePath)
    writeFileSync(sourcePath, 'after!')
    const targetPath = join(root, 'changed.turboflux-profile')
    await expect(writeProfileArchive({
      targetPath,
      entries: [{ path: `blobs/sha256/${digest('before')}`, sourcePath, sourceMtimeMs: snapshot.mtimeMs, size: 6, digest: digest('before') }],
    })).rejects.toMatchObject({ code: 'ARCHIVE_COMPONENT_INVALID' })
    expect(() => readFileSync(targetPath)).toThrow()
    expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('keeps the event loop responsive during a multi-megabyte streaming export', async () => {
    const root = directory()
    const data = randomBytes(8 * 1024 * 1024)
    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 5)
    try {
      await writeProfileArchive({
        targetPath: join(root, 'large.turboflux-profile'),
        entries: [{ path: 'blobs/sha256/large', data, size: data.length, digest: digest(data) }],
      })
    } finally {
      clearInterval(timer)
    }
    expect(ticks).toBeGreaterThan(2)
  })
})
