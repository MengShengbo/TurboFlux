import { createHash } from 'node:crypto'
import { createReadStream, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGunzip } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createArchiveDecipher } from './archiveCrypto'
import { readProfileArchive, verifyProfileArchiveContainer, writeProfileArchive } from './container'
import { ProfileArchiveError, type ProfileArchiveContainerHeaderV1 } from './types'

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, createReadStream: vi.fn(original.createReadStream) }
})

vi.mock('node:zlib', async importOriginal => {
  const original = await importOriginal<typeof import('node:zlib')>()
  return { ...original, createGunzip: vi.fn(original.createGunzip) }
})

vi.mock('./archiveCrypto', async importOriginal => {
  const original = await importOriginal<typeof import('./archiveCrypto')>()
  return { ...original, createArchiveDecipher: vi.fn(original.createArchiveDecipher) }
})

const directories: string[] = []
const password = 'archive lifecycle regression'

function readingStreams() {
  return [
    ...vi.mocked(createReadStream).mock.results,
    ...vi.mocked(createArchiveDecipher).mock.results,
    ...vi.mocked(createGunzip).mock.results,
  ].flatMap(result => result.type === 'return' ? [result.value] : [])
}

function expectClosedStreams(): void {
  const streams = readingStreams()
  expect(streams.length).toBeGreaterThan(0)
  for (const stream of streams) {
    expect(stream.destroyed).toBe(true)
    expect(stream.closed).toBe(true)
  }
}

async function withinDeadline<T>(result: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      result,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Archive read did not settle within 1500 ms')), 1_500)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function archive(encrypted = true): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'turboflux-archive-lifecycle-'))
  directories.push(root)
  const path = join(root, 'profile.turboflux-profile')
  const data = Buffer.from('authenticated archive content')
  await writeProfileArchive({
    targetPath: path,
    password: encrypted ? password : undefined,
    entries: [{ path: 'content.txt', data, size: data.length, digest: createHash('sha256').update(data).digest('hex') }],
  })
  vi.clearAllMocks()
  return path
}

afterEach(() => {
  for (const stream of readingStreams()) stream.destroy()
  vi.resetAllMocks()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('profile archive read lifecycle', () => {
  it.each(['tag', 'aad', 'ciphertext'] as const)('rejects damaged %s within the deadline and closes every stream', async damage => {
    const path = await archive()
    let bytes = readFileSync(path)
    if (damage === 'tag') {
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff
    } else if (damage === 'aad') {
      const headerLength = bytes.readUInt32BE(20)
      const header = JSON.parse(bytes.subarray(32, 32 + headerLength).toString('utf8')) as ProfileArchiveContainerHeaderV1
      // Reordering JSON keeps the key, nonce and ciphertext intact, but changes AAD.
      const { encrypted, ...rest } = header
      const reordered = Buffer.from(JSON.stringify({ encrypted, ...rest }))
      expect(reordered.length).toBe(headerLength)
      reordered.copy(bytes, 32)
    } else {
      const payloadEnd = bytes.length - 16
      bytes = Buffer.concat([bytes.subarray(0, payloadEnd - 8), bytes.subarray(payloadEnd)])
      bytes.writeBigUInt64BE(bytes.readBigUInt64BE(24) - 8n, 24)
    }
    writeFileSync(path, bytes)

    await expect(withinDeadline(verifyProfileArchiveContainer({ path, password })))
      .rejects.toMatchObject({ code: 'ARCHIVE_AUTHENTICATION_FAILED' })
    expectClosedStreams()
  })

  it('rejects a truncated envelope before opening payload streams', async () => {
    const path = await archive()
    writeFileSync(path, readFileSync(path).subarray(0, -1))
    await expect(withinDeadline(verifyProfileArchiveContainer({ path, password })))
      .rejects.toMatchObject({ code: 'ARCHIVE_CORRUPT' })
    expect(readingStreams()).toEqual([])
  })

  it('does not open payload streams when key derivation parameters are invalid', async () => {
    const path = await archive()
    const bytes = readFileSync(path)
    const headerLength = bytes.readUInt32BE(20)
    const header = JSON.parse(bytes.subarray(32, 32 + headerLength).toString('utf8')) as ProfileArchiveContainerHeaderV1
    header.kdf!.cost += 1
    const changed = Buffer.from(JSON.stringify(header))
    expect(changed.length).toBe(headerLength)
    changed.copy(bytes, 32)
    writeFileSync(path, bytes)
    await expect(withinDeadline(verifyProfileArchiveContainer({ path, password })))
      .rejects.toMatchObject({ code: 'ARCHIVE_AUTHENTICATION_FAILED' })
    expect(readingStreams()).toEqual([])
  })

  it('rejects an empty payload before creating any streams', async () => {
    const path = await archive()
    const bytes = readFileSync(path)
    const headerEnd = 32 + bytes.readUInt32BE(20)
    const empty = Buffer.concat([bytes.subarray(0, headerEnd), bytes.subarray(-16)])
    empty.writeBigUInt64BE(0n, 24)
    writeFileSync(path, empty)
    await expect(verifyProfileArchiveContainer({ path, password })).rejects.toMatchObject({ code: 'ARCHIVE_CORRUPT' })
    expect(readingStreams()).toEqual([])
  })

  it.each([false, true])('propagates a payload I/O failure and closes the chain (encrypted=%s)', async encrypted => {
    const path = await archive(encrypted)
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
    if (!encrypted) vi.mocked(createReadStream).mockImplementationOnce(fs.createReadStream)
    vi.mocked(createReadStream).mockImplementationOnce((path, options) => {
      const source = fs.createReadStream(path, { ...(options as object), highWaterMark: 32 })
      source.once('data', () => source.destroy(Object.assign(new Error('Injected read failure'), { code: 'EIO' })))
      return source
    })
    await expect(withinDeadline(verifyProfileArchiveContainer({ path, password })))
      .rejects.toMatchObject({ code: encrypted ? 'ARCHIVE_AUTHENTICATION_FAILED' : 'ARCHIVE_CORRUPT' })
    expectClosedStreams()
  })

  it.each([false, true])('cancels a stalled read before the first entry (encrypted=%s)', async encrypted => {
    const path = await archive(encrypted)
    const controller = new AbortController()
    const reason = new Error('Cancelled while awaiting payload')
    const onEntry = vi.fn()
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(createReadStream).mockImplementationOnce((path, options) => {
      const source = fs.createReadStream(path, options)
      source._read = () => { controller.abort(reason) }
      return source
    })
    await expect(withinDeadline(readProfileArchive({ path, password, signal: controller.signal, onEntry })))
      .rejects.toBe(reason)
    expect(onEntry).not.toHaveBeenCalled()
    expectClosedStreams()
  })

  it('cancels while consuming an entry and preserves the cancellation reason', async () => {
    const path = await archive()
    const controller = new AbortController()
    const reason = new Error('Cancelled while consuming entry')
    let chunksRead = 0
    await expect(withinDeadline(readProfileArchive({
      path, password, signal: controller.signal,
      onEntry: async (_entry, content) => {
        for await (const _chunk of content) {
          chunksRead += 1
          controller.abort(reason)
        }
      },
    }))).rejects.toBe(reason)
    expect(chunksRead).toBe(1)
    expectClosedStreams()
  })

  it('rejects an already cancelled verification without opening the archive', async () => {
    const reason = new Error('Already cancelled')
    await expect(verifyProfileArchiveContainer({ path: 'not-opened', signal: AbortSignal.abort(reason) }))
      .rejects.toBe(reason)
    expect(readingStreams()).toEqual([])
  })

  it('preserves consumer errors and closes every stream', async () => {
    const path = await archive()
    const error = new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', 'Entry rejected', 'Stop import')
    await expect(withinDeadline(readProfileArchive({
      path, password, onEntry: async () => { throw error },
    }))).rejects.toBe(error)
    expectClosedStreams()
  })

  it('preserves resource limit failures and closes every stream', async () => {
    const path = await archive()
    await expect(withinDeadline(verifyProfileArchiveContainer({ path, password, limits: { maxExpandedBytes: 1 } })))
      .rejects.toMatchObject({ code: 'ARCHIVE_RESOURCE_LIMIT' })
    expectClosedStreams()
  })

  it('removes temporary output when cancelled during post-write verification', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-archive-verification-cancel-'))
    directories.push(root)
    const controller = new AbortController()
    const reason = new Error('Cancelled during export verification')
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(createReadStream).mockImplementationOnce((path, options) => {
      const source = fs.createReadStream(path, options)
      source.once('data', () => controller.abort(reason))
      return source
    })
    await expect(withinDeadline(writeProfileArchive({
      targetPath: join(root, 'cancelled.turboflux-profile'),
      entries: [], password, signal: controller.signal,
    }))).rejects.toBe(reason)
    expect(readdirSync(root)).toEqual([])
    expectClosedStreams()
  })
})
