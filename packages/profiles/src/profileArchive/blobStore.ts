import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { ProfileArchiveError, type ArchiveEntryInput } from './types'

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.json': 'application/json', '.md': 'text/markdown',
  '.txt': 'text/plain', '.csv': 'text/csv', '.zip': 'application/zip', '.gz': 'application/gzip',
}

export interface ArchiveBlobReference {
  digest: string
  size: number
  mime: string
  logicalName: string
  archivePath: string
}

export class ArchiveBlobStore {
  private readonly entries = new Map<string, ArchiveEntryInput>()

  async addFile(path: string, logicalName: string, mime?: string): Promise<ArchiveBlobReference> {
    const linkInfo = await lstat(path)
    if (linkInfo.isSymbolicLink()) throw new ProfileArchiveError('ARCHIVE_UNSAFE_ENTRY', '导出内容包含符号链接。', '请移除链接或取消选择该组件。')
    if (!linkInfo.isFile()) throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '导出内容包含不支持的文件类型。', '请取消选择该内容后重试。')
    const before = await stat(path)
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Buffer)
      size += (chunk as Buffer).length
    }
    const after = await stat(path)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || size !== before.size) {
      throw new ProfileArchiveError('ARCHIVE_COMPONENT_INVALID', '读取 Blob 时文件发生变化。', '请等待相关任务完成后重试。')
    }
    const digest = hash.digest('hex')
    const archivePath = `blobs/sha256/${digest}`
    if (!this.entries.has(digest)) {
      this.entries.set(digest, { path: archivePath, sourcePath: path, sourceMtimeMs: before.mtimeMs, size, digest })
    }
    return {
      digest,
      size,
      mime: mime || MIME_BY_EXTENSION[extname(logicalName).toLowerCase()] || 'application/octet-stream',
      logicalName: logicalName.normalize('NFC').slice(0, 240),
      archivePath,
    }
  }

  listEntries(): ArchiveEntryInput[] {
    return [...this.entries.values()].map(entry => ({ ...entry }))
  }

  get count(): number {
    return this.entries.size
  }
}
