import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { link, open, rm, stat, statfs, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { TextDecoder } from 'node:util'
import { createGunzip, createGzip } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { canonicalJsonBytes } from './canonicalJson'
import { assertUniqueArchivePaths, normalizeArchivePath } from './archivePath'
import { createArchiveCipher, createArchiveDecipher, createArchiveEncryption, deriveArchiveKey } from './archiveCrypto'
import { parseManifestBytes } from './manifest'
import {
  DEFAULT_PROFILE_ARCHIVE_LIMITS,
  PROFILE_ARCHIVE_CONTAINER_VERSION,
  PROFILE_ARCHIVE_MAGIC,
  ProfileArchiveError,
  type ArchiveEntryInput,
  type ArchiveEntrySummary,
  type ProfileArchiveContainerHeaderV1,
  type ProfileArchiveReadLimits,
  type ProfileArchiveWriteResult,
} from './types'

const PRELUDE_SIZE = 32
const TRAILER_DIGEST_SIZE = 32
const FLAG_ENCRYPTED = 1
const MAX_HEADER_BYTES = 16 * 1024
const CHUNK_SIZE = 256 * 1024
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

interface ParsedEnvelope {
  header: ProfileArchiveContainerHeaderV1
  headerBytes: Buffer
  aad: Buffer
  payloadOffset: number
  payloadLength: number
  trailer: Buffer
  encrypted: boolean
}

function passwordBuffer(password?: string | Uint8Array): Buffer | undefined {
  if (password === undefined) return undefined
  return Buffer.from(password)
}

function prelude(headerLength: number, encrypted: boolean, payloadLength = 0): Buffer {
  const result = Buffer.alloc(PRELUDE_SIZE)
  result.write(PROFILE_ARCHIVE_MAGIC, 0, 'ascii')
  result.writeUInt16BE(PROFILE_ARCHIVE_CONTAINER_VERSION, 16)
  result.writeUInt16BE(encrypted ? FLAG_ENCRYPTED : 0, 18)
  result.writeUInt32BE(headerLength, 20)
  result.writeBigUInt64BE(BigInt(payloadLength), 24)
  return result
}

function aadFor(preludeBytes: Buffer, headerBytes: Buffer): Buffer {
  return Buffer.concat([preludeBytes.subarray(0, 24), headerBytes])
}

function decodeEntryPath(bytes: Buffer): string {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch {
    throw new ProfileArchiveError('ARCHIVE_UNSAFE_ENTRY', '资料包内部路径不是有效的 UTF-8。', '请勿导入该文件，并从可信来源重新导出。')
  }
}

function digestTransform(hash: ReturnType<typeof createHash>, onBytes: (count: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      onBytes(chunk.length)
      callback(null, chunk)
    },
  })
}

async function* entryFrames(entries: ArchiveEntryInput[], signal?: AbortSignal): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    if (signal?.aborted) throw signal.reason ?? new Error('Archive export cancelled')
    const path = normalizeArchivePath(entry.path)
    const pathBytes = Buffer.from(path, 'utf8')
    if (pathBytes.length > 1_024) throw new ProfileArchiveError('ARCHIVE_UNSAFE_ENTRY', '资料包内部路径过长。', '请缩短相关名称后重试。')
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/u.test(entry.digest)) {
      throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '导出组件提供了无效的条目元数据。', '请重试导出；若问题持续，请导出诊断。')
    }
    const header = Buffer.alloc(44)
    header.writeUInt32BE(pathBytes.length, 0)
    header.writeBigUInt64BE(BigInt(entry.size), 4)
    Buffer.from(entry.digest, 'hex').copy(header, 12)
    yield header
    yield pathBytes
    const actualDigest = createHash('sha256')
    let actualSize = 0
    if (entry.data !== undefined) {
      const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data)
      for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
        if (signal?.aborted) throw signal.reason ?? new Error('Archive export cancelled')
        const chunk = data.subarray(offset, Math.min(data.length, offset + CHUNK_SIZE))
        actualDigest.update(chunk)
        actualSize += chunk.length
        yield chunk
      }
    } else if (entry.sourcePath) {
      const before = await stat(entry.sourcePath)
      if (!before.isFile() || before.size !== entry.size || (entry.sourceMtimeMs !== undefined && before.mtimeMs !== entry.sourceMtimeMs)) {
        throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '导出期间有文件发生变化。', '请等待相关任务完成后重新导出。')
      }
      for await (const rawChunk of createReadStream(entry.sourcePath, { highWaterMark: CHUNK_SIZE })) {
        if (signal?.aborted) throw signal.reason ?? new Error('Archive export cancelled')
        const chunk = Buffer.from(rawChunk)
        actualDigest.update(chunk)
        actualSize += chunk.length
        yield chunk
      }
      const after = await stat(entry.sourcePath)
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '导出期间有文件发生变化。', '请等待相关任务完成后重新导出。')
      }
    } else {
      throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '导出条目没有可读取的内容。', '请重试导出。')
    }
    if (actualSize !== entry.size || actualDigest.digest('hex') !== entry.digest) {
      throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '导出条目校验失败。', '请等待相关文件写入完成后重试。')
    }
  }
  yield Buffer.alloc(4)
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export async function writeProfileArchive(input: {
  targetPath: string
  entries: ArchiveEntryInput[]
  password?: string | Uint8Array
  signal?: AbortSignal
  verifyDocument?: boolean
  availableBytes?: (directory: string) => Promise<number>
}): Promise<ProfileArchiveWriteResult> {
  assertUniqueArchivePaths(input.entries.map(entry => entry.path))
  const targetExists = await stat(input.targetPath).then(() => true, () => false)
  if (targetExists) throw new ProfileArchiveError('ARCHIVE_TARGET_EXISTS', '目标文件已经存在。', '请选择新的文件名或位置。')
  const requiredBytes = input.entries.reduce((sum, entry) => sum + entry.size + Buffer.byteLength(entry.path, 'utf8') + 44, 0) + 8 * 1024 * 1024
  const availableBytes = input.availableBytes
    ? await input.availableBytes(dirname(input.targetPath))
    : await statfs(dirname(input.targetPath)).then(info => Number(info.bavail) * Number(info.bsize), () => Number.POSITIVE_INFINITY)
  if (availableBytes < requiredBytes) {
    throw new ProfileArchiveError('ARCHIVE_DISK_SPACE_LOW', '可用磁盘空间不足，尚未开始导出。', '请释放空间、减少导出内容或选择其他磁盘。')
  }
  const secret = passwordBuffer(input.password)
  const encrypted = Boolean(secret?.length)
  const material = encrypted ? await createArchiveEncryption(secret!) : undefined
  const header: ProfileArchiveContainerHeaderV1 = {
    containerVersion: PROFILE_ARCHIVE_CONTAINER_VERSION,
    compression: 'gzip',
    encrypted,
    ...material?.header,
  }
  const headerBytes = canonicalJsonBytes(header)
  const preludeBytes = prelude(headerBytes.length, encrypted)
  const aad = aadFor(preludeBytes, headerBytes)
  const temporaryPath = join(dirname(input.targetPath), `.${basename(input.targetPath)}.${randomUUID()}.tmp`)
  const compressedHash = createHash('sha256')
  let payloadLength = 0
  let trailer: Buffer | undefined
  try {
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.write(Buffer.concat([preludeBytes, headerBytes]), 0, PRELUDE_SIZE + headerBytes.length, 0)
      await handle.sync()
    } finally {
      await handle.close()
    }
    const gzip = createGzip({ level: 6 })
    const counter = digestTransform(compressedHash, count => { payloadLength += count })
    const output = createWriteStream(temporaryPath, { flags: 'r+', start: PRELUDE_SIZE + headerBytes.length })
    if (material) {
      const cipher = createArchiveCipher(material.key, header, aad)
      await pipeline(Readable.from(entryFrames(input.entries, input.signal)), gzip, cipher, counter, output, { signal: input.signal })
      trailer = cipher.getAuthTag()
    } else {
      await pipeline(Readable.from(entryFrames(input.entries, input.signal)), gzip, counter, output, { signal: input.signal })
      trailer = Buffer.from(compressedHash.digest())
    }
    const finalize = await open(temporaryPath, 'r+')
    try {
      await finalize.write(trailer, 0, trailer.length, PRELUDE_SIZE + headerBytes.length + payloadLength)
      const lengthBytes = Buffer.alloc(8)
      lengthBytes.writeBigUInt64BE(BigInt(payloadLength))
      await finalize.write(lengthBytes, 0, lengthBytes.length, 24)
      await finalize.sync()
    } finally {
      await finalize.close()
    }
    if (input.verifyDocument) await verifyProfileArchive({ path: temporaryPath, password: secret })
    else await verifyProfileArchiveContainer({ path: temporaryPath, password: secret })
    try {
      await link(temporaryPath, input.targetPath)
      await unlink(temporaryPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ProfileArchiveError('ARCHIVE_TARGET_EXISTS', '目标文件已经存在。', '请选择新的文件名或位置。')
      }
      throw error
    }
    await fsyncDirectory(dirname(input.targetPath))
    const info = await stat(input.targetPath)
    return {
      path: input.targetPath,
      physicalBytes: info.size,
      sha256: await fileSha256(input.targetPath),
      encrypted,
      entries: input.entries.map(entry => ({ path: normalizeArchivePath(entry.path), size: entry.size, digest: entry.digest })),
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    material?.key.fill(0)
    secret?.fill(0)
  }
}

function parseHeader(value: unknown, encryptedFlag: boolean): ProfileArchiveContainerHeaderV1 {
  if (!value || typeof value !== 'object') throw new Error('Archive header is invalid')
  const header = value as Partial<ProfileArchiveContainerHeaderV1>
  if (header.containerVersion !== PROFILE_ARCHIVE_CONTAINER_VERSION || header.compression !== 'gzip' || header.encrypted !== encryptedFlag) {
    throw new Error('Archive header is unsupported')
  }
  if (encryptedFlag && (header.kdf?.algorithm !== 'scrypt' || header.cipher?.algorithm !== 'aes-256-gcm')) throw new Error('Archive encryption is unsupported')
  if (!encryptedFlag && (header.kdf || header.cipher)) throw new Error('Unencrypted archive has encryption metadata')
  return header as ProfileArchiveContainerHeaderV1
}

async function readEnvelope(path: string, limits: ProfileArchiveReadLimits): Promise<ParsedEnvelope> {
  const info = await stat(path)
  if (!info.isFile() || info.size > limits.maxArchiveBytes || info.size < PRELUDE_SIZE + TRAILER_DIGEST_SIZE) {
    throw new ProfileArchiveError('ARCHIVE_RESOURCE_LIMIT', '资料包大小超出安全限制。', '请选择较小的资料包或调整导出范围。')
  }
  const handle = await open(path, 'r')
  try {
    const preludeBytes = Buffer.alloc(PRELUDE_SIZE)
    if ((await handle.read(preludeBytes, 0, PRELUDE_SIZE, 0)).bytesRead !== PRELUDE_SIZE) throw new Error('Archive prelude is truncated')
    if (preludeBytes.subarray(0, 16).toString('ascii') !== PROFILE_ARCHIVE_MAGIC) throw new Error('Archive magic is invalid')
    if (preludeBytes.readUInt16BE(16) !== PROFILE_ARCHIVE_CONTAINER_VERSION) {
      throw new ProfileArchiveError('ARCHIVE_UNSUPPORTED_VERSION', '该资料包版本无法由当前 TurboFlux 打开。', '请升级 TurboFlux 后重试。')
    }
    const flags = preludeBytes.readUInt16BE(18)
    if ((flags & ~FLAG_ENCRYPTED) !== 0) throw new Error('Archive flags are invalid')
    const encrypted = Boolean(flags & FLAG_ENCRYPTED)
    const headerLength = preludeBytes.readUInt32BE(20)
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) throw new Error('Archive header length is invalid')
    const payloadBigInt = preludeBytes.readBigUInt64BE(24)
    if (payloadBigInt > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Archive payload is too large')
    const payloadLength = Number(payloadBigInt)
    const headerBytes = Buffer.alloc(headerLength)
    if ((await handle.read(headerBytes, 0, headerLength, PRELUDE_SIZE)).bytesRead !== headerLength) throw new Error('Archive header is truncated')
    const header = parseHeader(JSON.parse(headerBytes.toString('utf8')) as unknown, encrypted)
    const trailerLength = encrypted ? header.cipher!.tagLength : TRAILER_DIGEST_SIZE
    const expectedSize = PRELUDE_SIZE + headerLength + payloadLength + trailerLength
    if (expectedSize !== info.size) throw new Error('Archive length does not match its header')
    const trailer = Buffer.alloc(trailerLength)
    if ((await handle.read(trailer, 0, trailerLength, expectedSize - trailerLength)).bytesRead !== trailerLength) throw new Error('Archive trailer is truncated')
    return {
      header,
      headerBytes,
      aad: aadFor(preludeBytes, headerBytes),
      payloadOffset: PRELUDE_SIZE + headerLength,
      payloadLength,
      trailer,
      encrypted,
    }
  } catch (error) {
    if (error instanceof ProfileArchiveError) throw error
    throw new ProfileArchiveError('ARCHIVE_CORRUPT', '资料包头部损坏或格式无效。', '请重新获取或重新导出该资料包。')
  } finally {
    await handle.close()
  }
}

class StreamByteReader {
  private buffer = Buffer.alloc(0)
  private done = false
  private expandedBytes = 0

  constructor(
    private readonly iterator: AsyncIterator<Buffer>,
    private readonly limits: ProfileArchiveReadLimits,
    private readonly compressedBytes: number,
  ) {}

  private async fill(length: number): Promise<void> {
    while (this.buffer.length < length && !this.done) {
      const next = await this.iterator.next()
      if (next.done) {
        this.done = true
        break
      }
      const chunk = Buffer.from(next.value)
      this.expandedBytes += chunk.length
      if (this.expandedBytes > this.limits.maxExpandedBytes
        || (this.compressedBytes > 0 && this.expandedBytes / this.compressedBytes > this.limits.maxCompressionRatio)) {
        throw new ProfileArchiveError('ARCHIVE_RESOURCE_LIMIT', '资料包展开后超出安全限制。', '请减少导出内容后重试。')
      }
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    }
    if (this.buffer.length < length) throw new Error('Archive payload is truncated')
  }

  async read(length: number): Promise<Buffer> {
    await this.fill(length)
    const result = this.buffer.subarray(0, length)
    this.buffer = this.buffer.subarray(length)
    return result
  }

  async *chunks(length: number): AsyncGenerator<Buffer> {
    let remaining = length
    while (remaining > 0) {
      if (this.buffer.length === 0) await this.fill(1)
      const take = Math.min(remaining, this.buffer.length, CHUNK_SIZE)
      const chunk = this.buffer.subarray(0, take)
      this.buffer = this.buffer.subarray(take)
      remaining -= take
      yield chunk
    }
  }

  async assertEnd(): Promise<void> {
    if (this.buffer.length > 0) throw new Error('Archive payload has trailing data')
    const next = await this.iterator.next()
    if (!next.done && Buffer.from(next.value).length > 0) throw new Error('Archive payload has trailing data')
  }
}

export async function readProfileArchive(input: {
  path: string
  password?: string | Uint8Array
  limits?: Partial<ProfileArchiveReadLimits>
  onEntry?: (entry: ArchiveEntrySummary, content: AsyncIterable<Buffer>) => Promise<void>
}): Promise<{ header: ProfileArchiveContainerHeaderV1; entries: ArchiveEntrySummary[] }> {
  const limits = { ...DEFAULT_PROFILE_ARCHIVE_LIMITS, ...input.limits }
  const envelope = await readEnvelope(input.path, limits)
  const secret = passwordBuffer(input.password)
  let key: Buffer | undefined
  try {
    if (envelope.encrypted && !secret?.length) {
      throw new ProfileArchiveError('ARCHIVE_AUTHENTICATION_FAILED', '密码错误或资料包已损坏。', '请重新输入导出时使用的密码。')
    }
    const payloadEnd = envelope.payloadOffset + envelope.payloadLength - 1
    const source = createReadStream(input.path, { start: envelope.payloadOffset, end: payloadEnd })
    source.on('error', () => undefined)
    let decoded: Readable = source
    if (envelope.encrypted) {
      try {
        key = await deriveArchiveKey(secret!, envelope.header)
        const decipher = createArchiveDecipher(key, envelope.header, envelope.aad, envelope.trailer)
        decipher.on('error', () => undefined)
        decoded = decoded.pipe(decipher)
      } catch {
        throw new ProfileArchiveError('ARCHIVE_AUTHENTICATION_FAILED', '密码错误或资料包已损坏。', '请重新输入密码，或重新获取资料包。')
      }
    } else {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(input.path, { start: envelope.payloadOffset, end: payloadEnd })) hash.update(chunk as Buffer)
      if (!hash.digest().equals(envelope.trailer)) throw new ProfileArchiveError('ARCHIVE_CORRUPT', '资料包完整性校验失败。', '请重新获取或重新导出该资料包。')
    }
    const gunzip = createGunzip()
    gunzip.on('error', () => undefined)
    decoded = decoded.pipe(gunzip)
    const iterator = decoded[Symbol.asyncIterator]() as AsyncIterator<Buffer>
    const reader = new StreamByteReader(iterator, limits, envelope.payloadLength)
    const entries: ArchiveEntrySummary[] = []
    const seen = new Set<string>()
    const portableSeen = new Set<string>()
    try {
      while (true) {
        const pathLength = (await reader.read(4)).readUInt32BE(0)
        if (pathLength === 0) break
        if (pathLength > limits.maxPathBytes) throw new ProfileArchiveError('ARCHIVE_RESOURCE_LIMIT', '资料包内部路径超出安全限制。', '请重新导出资料包。')
        if (entries.length >= limits.maxEntries) throw new ProfileArchiveError('ARCHIVE_RESOURCE_LIMIT', '资料包条目数量超出安全限制。', '请减少导出内容后重试。')
        const metadata = await reader.read(40)
        const sizeBigInt = metadata.readBigUInt64BE(0)
        if (sizeBigInt > BigInt(limits.maxEntryBytes) || sizeBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new ProfileArchiveError('ARCHIVE_RESOURCE_LIMIT', '资料包单个条目超出安全限制。', '请取消选择大型附件后重试。')
        }
        const size = Number(sizeBigInt)
        const expectedDigest = metadata.subarray(8, 40).toString('hex')
        const path = normalizeArchivePath(decodeEntryPath(await reader.read(pathLength)))
        const portablePath = path.toLocaleLowerCase('en-US')
        if (seen.has(path) || portableSeen.has(portablePath)) throw new ProfileArchiveError('ARCHIVE_UNSAFE_ENTRY', '资料包包含重复条目。', '请重新导出资料包。')
        seen.add(path)
        portableSeen.add(portablePath)
        const hash = createHash('sha256')
        let consumed = 0
        const content = async function* (): AsyncGenerator<Buffer> {
          for await (const chunk of reader.chunks(size)) {
            consumed += chunk.length
            hash.update(chunk)
            yield chunk
          }
        }
        const summary = { path, size, digest: expectedDigest }
        await input.onEntry?.(summary, content())
        if (consumed < size) {
          for await (const chunk of reader.chunks(size - consumed)) hash.update(chunk)
        }
        if (hash.digest('hex') !== expectedDigest) throw new ProfileArchiveError('ARCHIVE_CORRUPT', '资料包条目校验失败。', '请重新获取或重新导出该资料包。')
        entries.push(summary)
      }
      await reader.assertEnd()
      return { header: envelope.header, entries }
    } catch (error) {
      decoded.destroy()
      source.destroy()
      if (error instanceof ProfileArchiveError) throw error
      throw new ProfileArchiveError(
        envelope.encrypted ? 'ARCHIVE_AUTHENTICATION_FAILED' : 'ARCHIVE_CORRUPT',
        envelope.encrypted ? '密码错误或资料包已损坏。' : '资料包内容损坏或不完整。',
        envelope.encrypted ? '请重新输入密码，或重新获取资料包。' : '请重新获取或重新导出该资料包。',
      )
    }
  } finally {
    key?.fill(0)
    secret?.fill(0)
  }
}

export async function verifyProfileArchive(input: {
  path: string
  password?: string | Uint8Array
  limits?: Partial<ProfileArchiveReadLimits>
}): Promise<ArchiveEntrySummary[]> {
  const documents = new Map<string, Buffer>()
  const result = await readProfileArchive({
    ...input,
    onEntry: async (entry, content) => {
      if (entry.path !== 'manifest.json' && entry.path !== 'checksums.json') return
      if (entry.size > 32 * 1024 * 1024) {
        throw new ProfileArchiveError('ARCHIVE_RESOURCE_LIMIT', '资料包清单超出安全限制。', '请减少导出内容后重试。')
      }
      const chunks: Buffer[] = []
      for await (const chunk of content) chunks.push(chunk)
      documents.set(entry.path, Buffer.concat(chunks, entry.size))
    },
  })
  const manifestBytes = documents.get('manifest.json')
  const checksumBytes = documents.get('checksums.json')
  if (!manifestBytes || !checksumBytes || !result.entries.some(entry => entry.path === 'profile/profile.json')) {
    throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '资料包缺少必要的清单或资料信息。', '请重新导出资料包。')
  }
  const manifest = parseManifestBytes(manifestBytes)
  let checksums: unknown
  try { checksums = JSON.parse(checksumBytes.toString('utf8')) as unknown } catch {
    throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '资料包校验清单不是有效 JSON。', '请重新导出资料包。')
  }
  if (!checksums || typeof checksums !== 'object' || Array.isArray(checksums)
    || (checksums as Record<string, unknown>).schemaVersion !== 1
    || (checksums as Record<string, unknown>).algorithm !== 'sha256'
    || !(checksums as Record<string, unknown>).entries
    || typeof (checksums as Record<string, unknown>).entries !== 'object') {
    throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '资料包校验清单格式无效。', '请重新导出资料包。')
  }
  const expected = (checksums as { entries: Record<string, { sha256?: unknown; bytes?: unknown }> }).entries
  const actual = new Map(result.entries.map(entry => [entry.path, entry]))
  for (const [path, checksum] of Object.entries(expected)) {
    const normalizedPath = normalizeArchivePath(path)
    const entry = actual.get(normalizedPath)
    if (!entry || checksum.sha256 !== entry.digest || checksum.bytes !== entry.size) {
      throw new ProfileArchiveError('ARCHIVE_CORRUPT', '资料包内容与校验清单不一致。', '请重新获取或重新导出该资料包。')
    }
  }
  const accounted = new Set(['manifest.json', 'checksums.json', ...Object.keys(expected).map(normalizeArchivePath)])
  if (result.entries.some(entry => !accounted.has(entry.path))) {
    throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '资料包包含未在校验清单中声明的内容。', '请重新导出资料包。')
  }
  for (const component of manifest.components) {
    if (!result.entries.some(entry => entry.path.startsWith(`components/${component.id}/`))) {
      throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', `资料包缺少 ${component.id} 组件内容。`, '请重新导出资料包。')
    }
  }
  return result.entries
}

export async function verifyProfileArchiveContainer(input: {
  path: string
  password?: string | Uint8Array
  limits?: Partial<ProfileArchiveReadLimits>
}): Promise<ArchiveEntrySummary[]> {
  return (await readProfileArchive(input)).entries
}

export async function collectProfileArchiveEntries(input: {
  path: string
  password?: string | Uint8Array
  maxCollectedBytes?: number
  limits?: Partial<ProfileArchiveReadLimits>
}): Promise<Map<string, Buffer>> {
  const maximum = input.maxCollectedBytes ?? 64 * 1024 * 1024
  let collected = 0
  const entries = new Map<string, Buffer>()
  await readProfileArchive({
    ...input,
    onEntry: async (entry, content) => {
      collected += entry.size
      if (collected > maximum) throw new ProfileArchiveError('ARCHIVE_RESOURCE_LIMIT', '资料包预览内容超出安全限制。', '请减少导出范围后重试。')
      const chunks: Buffer[] = []
      for await (const chunk of content) chunks.push(chunk)
      entries.set(entry.path, Buffer.concat(chunks, entry.size))
    },
  })
  return entries
}

export async function inspectProfileArchiveEnvelope(path: string): Promise<{
  encrypted: boolean
  physicalBytes: number
  containerVersion: number
}> {
  const limits = DEFAULT_PROFILE_ARCHIVE_LIMITS
  const envelope = await readEnvelope(path, limits)
  return {
    encrypted: envelope.encrypted,
    physicalBytes: (await stat(path)).size,
    containerVersion: envelope.header.containerVersion,
  }
}
