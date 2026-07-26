import type { SubAgentEvidence } from '../shared/subAgentTypes'

export interface FastContextEvidenceRecord {
  id: string
  evidence: SubAgentEvidence
  readConfirmed: boolean
}

export interface FastContextEvidenceRegistration {
  record: FastContextEvidenceRecord
  isNew: boolean
}

function evidenceKey(evidence: SubAgentEvidence): string {
  return [
    evidence.path.replace(/\\/g, '/').toLowerCase(),
    evidence.startLine,
    evidence.endLine,
    evidence.reason,
  ].join(':')
}

function normalizeEvidenceId(value: unknown): string {
  const normalized = String(value || '').trim().toUpperCase()
  return /^E\d+$/.test(normalized) ? normalized : ''
}

export class FastContextEvidenceLedger {
  private readonly recordsById = new Map<string, FastContextEvidenceRecord>()
  private readonly idsByKey = new Map<string, string>()
  private nextId = 1

  constructor(initialEvidence: readonly SubAgentEvidence[] = []) {
    initialEvidence.forEach(evidence => this.register(evidence))
  }

  register(evidence: SubAgentEvidence): FastContextEvidenceRegistration {
    const key = evidenceKey(evidence)
    const existingId = this.idsByKey.get(key)
    if (existingId) {
      return { record: this.recordsById.get(existingId)!, isNew: false }
    }

    const id = `E${this.nextId++}`
    const record: FastContextEvidenceRecord = {
      id,
      evidence,
      readConfirmed: evidence.reason === 'file read',
    }
    this.idsByKey.set(key, id)
    this.recordsById.set(id, record)
    return { record, isNew: true }
  }

  resolve(ids: readonly unknown[]): FastContextEvidenceRecord[] {
    const seen = new Set<string>()
    const records: FastContextEvidenceRecord[] = []
    for (const rawId of ids) {
      const id = normalizeEvidenceId(rawId)
      if (!id || seen.has(id)) continue
      seen.add(id)
      const record = this.recordsById.get(id)
      if (record) records.push(record)
    }
    return records
  }

  has(id: unknown): boolean {
    return this.recordsById.has(normalizeEvidenceId(id))
  }

  records(): FastContextEvidenceRecord[] {
    return [...this.recordsById.values()]
  }

  evidence(): SubAgentEvidence[] {
    return this.records().map(record => record.evidence)
  }

  format(records: readonly FastContextEvidenceRecord[]): string {
    if (records.length === 0) return ''
    const lines = records.map(record => {
      const evidence = record.evidence
      const source = record.readConfirmed ? 'read' : 'search'
      const preview = evidence.preview.replace(/\s+/g, ' ').trim().slice(0, 180)
      return `${record.id} | ${source} | ${evidence.path}:L${evidence.startLine}-L${evidence.endLine} | ${preview}`
    })
    return `EVIDENCE_HANDLES\n${lines.join('\n')}`
  }
}
