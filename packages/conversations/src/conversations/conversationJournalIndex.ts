import { createHash, randomUUID, type Hash } from 'node:crypto'
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isConversationV2Id } from './conversationV2Ids'

interface IndexCheckpoint {
  schemaVersion: 1
  conversationId: string
  profileId?: string
  journalVersion: string
  journalBytes: number
  needsSeparator: boolean
  count: number
  indexHash: string
}

export interface ConversationJournalIndex {
  conversationId: string
  profileId?: string
  journalVersion: string
  journalBytes: number
  needsSeparator: boolean
  ids: Map<string, number>
  eventIds: string[]
  offsets: number[]
  hash: Hash
  dataVersion?: string
}

export function conversationJournalVersion(path: string): string {
  try {
    const info = statSync(path, { bigint: true })
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

function checksum(value: IndexCheckpoint): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Rebuildable metadata only. Callers hold the journal lock while loading or publishing. */
export class ConversationJournalIndexes {
  // Retain only the active journal's metadata; switching conversations releases the previous index.
  private cached?: ConversationJournalIndex

  constructor(private readonly root: string, private readonly onRead?: (bytes: number, path: string) => void) {}

  load(conversationId: string, cachedOnly = false): ConversationJournalIndex | undefined {
    const journalVersion = conversationJournalVersion(join(this.root, `${conversationId}.jsonl`))
    const dataPath = join(this.root, `${conversationId}.index`)
    try {
      if (this.cached?.conversationId === conversationId && this.cached.journalVersion === journalVersion
        && this.cached.dataVersion === conversationJournalVersion(dataPath)) return this.cached
    } catch {}
    this.cached = undefined
    if (cachedOnly || journalVersion === 'missing') return undefined
    try {
      const path = join(this.root, `${conversationId}.index.json`)
      if (statSync(path).size > 4096) return undefined
      const raw = readFileSync(path)
      this.onRead?.(raw.length, path)
      const { checksum: savedChecksum, ...checkpoint } = JSON.parse(raw.toString('utf8')) as IndexCheckpoint & { checksum: string }
      if (checkpoint.schemaVersion !== 1 || checkpoint.conversationId !== conversationId
        || checkpoint.journalVersion !== journalVersion || checksum(checkpoint) !== savedChecksum
        || !Number.isSafeInteger(checkpoint.journalBytes) || checkpoint.journalBytes < 0
        || checkpoint.journalBytes !== statSync(join(this.root, `${conversationId}.jsonl`)).size
        || !Number.isSafeInteger(checkpoint.count) || checkpoint.count < 0
        || typeof checkpoint.needsSeparator !== 'boolean'
        || (checkpoint.count > 0 && (typeof checkpoint.profileId !== 'string' || !isConversationV2Id(checkpoint.profileId)))) return undefined
      if (statSync(dataPath).size > checkpoint.journalBytes) return undefined
      const data = readFileSync(dataPath)
      this.onRead?.(data.length, dataPath)
      const hash = createHash('sha256').update(data)
      if (hash.copy().digest('hex') !== checkpoint.indexHash) return undefined
      if (data.length > 0 && data[data.length - 1] !== 10) return undefined
      const lines = data.length ? data.toString('utf8').slice(0, -1).split('\n') : []
      if (lines.length !== checkpoint.count) return undefined
      const ids = new Map<string, number>()
      const eventIds: string[] = []
      const offsets: number[] = []
      for (const line of lines) {
        const row: unknown = JSON.parse(line)
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !isConversationV2Id(row[0])
          || ids.has(row[0]) || !Number.isSafeInteger(row[1]) || row[1] < 0 || row[1] >= checkpoint.journalBytes
          || (offsets.length > 0 && row[1] <= offsets[offsets.length - 1]!)) return undefined
        ids.set(row[0], ids.size + 1)
        eventIds.push(row[0])
        offsets.push(row[1])
      }
      this.cached = {
        conversationId, profileId: checkpoint.profileId, journalVersion, journalBytes: checkpoint.journalBytes,
        needsSeparator: checkpoint.needsSeparator, ids, eventIds, offsets, hash, dataVersion: conversationJournalVersion(dataPath),
      }
      return this.cached
    } catch {
      return undefined
    }
  }

  publish(index: ConversationJournalIndex, previousCount: number): void {
    const dataPath = join(this.root, `${index.conversationId}.index`)
    const checkpointPath = join(this.root, `${index.conversationId}.index.json`)
    const temporary = `${checkpointPath}.${randomUUID()}.tmp`
    this.cached = undefined
    try {
      const append = index.dataVersion !== undefined && index.dataVersion === conversationJournalVersion(dataPath)
      const start = append ? previousCount : 0
      const rows: string[] = []
      for (let seq = start; seq < index.eventIds.length; seq += 1) rows.push(JSON.stringify([index.eventIds[seq], index.offsets[seq]]))
      if (!append) index.hash = createHash('sha256')
      const data = rows.length ? `${rows.join('\n')}\n` : ''
      writeFileSync(dataPath, data, { encoding: 'utf8', mode: 0o600, flag: append ? 'a' : 'w' })
      index.hash.update(data)
      index.journalVersion = conversationJournalVersion(join(this.root, `${index.conversationId}.jsonl`))
      const checkpoint: IndexCheckpoint = {
        schemaVersion: 1, conversationId: index.conversationId, profileId: index.profileId,
        journalVersion: index.journalVersion, journalBytes: index.journalBytes, needsSeparator: index.needsSeparator,
        count: index.ids.size, indexHash: index.hash.copy().digest('hex'),
      }
      // The journal was fsynced first. Sidecars need no durability guarantee: missing or torn data fails validation.
      writeFileSync(temporary, JSON.stringify({ ...checkpoint, checksum: checksum(checkpoint) }), { mode: 0o600 })
      renameSync(temporary, checkpointPath)
      index.dataVersion = conversationJournalVersion(dataPath)
      this.cached = index
    } catch {
      // A derived index failure cannot undo an acknowledged journal commit.
    } finally {
      try { rmSync(temporary, { force: true }) } catch {}
    }
  }
}
