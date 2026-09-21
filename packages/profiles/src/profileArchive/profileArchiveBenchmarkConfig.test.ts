import { describe, expect, it } from 'vitest'
import { resolveProfileArchiveBenchmarkConfig } from '../../../../scripts/profile-archive-benchmark-config'

describe('profile archive benchmark qualification', () => {
  it('keeps the default development benchmark fast', () => {
    expect(resolveProfileArchiveBenchmarkConfig([], {})).toMatchObject({
      qualification: 'development',
      blobMiB: 64,
      roundTripBudgetMs: 30_000,
      rssBudgetMiB: 256,
    })
  })

  it('uses the contractual 1 GiB dataset in Stable mode', () => {
    expect(resolveProfileArchiveBenchmarkConfig(['--stable'], {})).toMatchObject({
      qualification: 'stable',
      blobMiB: 1_024,
      roundTripBudgetMs: 180_000,
      rssBudgetMiB: 256,
    })
  })

  it('rejects a Stable run whose fixture is smaller than 1 GiB', () => {
    expect(() => resolveProfileArchiveBenchmarkConfig(['--stable'], {
      TURBOFLUX_BENCH_BLOB_MIB: '64',
    })).toThrow('requires at least 1024 MiB')
  })
})
