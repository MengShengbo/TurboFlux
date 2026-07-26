import { describe, expect, it } from 'vitest'
import { FastContextEvidenceLedger } from './fastContextEvidenceLedger'

describe('FastContextEvidenceLedger', () => {
  it('assigns stable handles and records read authority', () => {
    const ledger = new FastContextEvidenceLedger()
    const evidence = {
      path: 'src/owner.ts',
      startLine: 10,
      endLine: 20,
      preview: 'export function owner() {}',
      reason: 'file read',
    }

    const first = ledger.register(evidence)
    const repeated = ledger.register({ ...evidence })

    expect(first).toMatchObject({ isNew: true, record: { id: 'E1', readConfirmed: true } })
    expect(repeated).toMatchObject({ isNew: false, record: { id: 'E1' } })
    expect(ledger.resolve(['e1', 'missing'])).toEqual([first.record])
    expect(ledger.format([first.record])).toContain('E1 | read | src/owner.ts:L10-L20')
  })
})
