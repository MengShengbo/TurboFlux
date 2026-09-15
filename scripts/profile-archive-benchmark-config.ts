export interface ProfileArchiveBenchmarkConfig {
  qualification: 'development' | 'stable'
  conversationCount: number
  blobMiB: number
  kdfBudgetMs: number
  roundTripBudgetMs: number
  rssBudgetMiB: number
}

const STABLE_MINIMUM_BLOB_MIB = 1_024

function integer(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback
}

export function resolveProfileArchiveBenchmarkConfig(
  argv: string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): ProfileArchiveBenchmarkConfig {
  const stable = argv.includes('--stable')
  const blobMiB = integer(environment.TURBOFLUX_BENCH_BLOB_MIB, stable ? STABLE_MINIMUM_BLOB_MIB : 64, 1)
  if (stable && blobMiB < STABLE_MINIMUM_BLOB_MIB) {
    throw new Error(`Stable profile archive benchmark requires at least ${STABLE_MINIMUM_BLOB_MIB} MiB, received ${blobMiB} MiB`)
  }
  return {
    qualification: stable ? 'stable' : 'development',
    conversationCount: integer(environment.TURBOFLUX_BENCH_CONVERSATIONS, 100, 1),
    blobMiB,
    kdfBudgetMs: integer(environment.TURBOFLUX_BENCH_KDF_BUDGET_MS, 1_500, 100),
    roundTripBudgetMs: integer(environment.TURBOFLUX_BENCH_ROUNDTRIP_BUDGET_MS, stable ? 180_000 : 30_000, 1_000),
    rssBudgetMiB: integer(environment.TURBOFLUX_BENCH_RSS_BUDGET_MIB, 256, 32),
  }
}
