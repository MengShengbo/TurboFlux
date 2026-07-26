import { describe, expect, it } from 'vitest'
import { extractPaths } from '../../scripts/retrieval-paper/runners'

describe('retrieval benchmark ranked path parsing', () => {
  it('parses FastContext edit-frontier output without including supporting context', () => {
    const report = `RANKED_CODE_MAP
EDIT_FRONTIER
1. src/math/Quaternion.js L220-L339 kind=owner
2. src/math/Euler.js L1-L310 kind=owner

SUPPORTING_CONTEXT
- src/math/Matrix3.js L1-L100 role=layout reference`

    expect(extractPaths(report, 'C:/repo')).toEqual([
      'src/math/quaternion.js',
      'src/math/euler.js',
    ])
  })

  it('continues to parse the legacy flat ranked format', () => {
    const report = `RANKED_CODE_MAP
1. src/core/owner.ts L10-L40 role=owner
2. src/core/consumer.ts L2-L12 role=consumer
UNCERTAINTY
- none`

    expect(extractPaths(report, 'C:/repo')).toEqual([
      'src/core/owner.ts',
      'src/core/consumer.ts',
    ])
  })
})
