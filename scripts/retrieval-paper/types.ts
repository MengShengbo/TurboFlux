export type DatasetId = 'swebench-verified' | 'swepolybench-verified'

export type RetrievalSystemId =
  | 'fastcontext'
  | 'claude-code-readonly'
  | 'opencode-explore'
  | 'neutral-tool-agent'
  | 'bm25'

export interface BenchmarkCase {
  id: string
  dataset: DatasetId
  repository: string
  baseCommit: string
  language: string
  category: string
  createdAt?: string
  objective: string
  goldPaths: string[]
  sourceGoldPaths: string[]
  testGoldPaths: string[]
  changedLines: number
  leakageRisk: boolean
  metadata: Record<string, string | number | boolean | null>
}

export interface BenchmarkManifest {
  schemaVersion: 1
  generatedAt: string
  seed: number
  sources: Array<{
    id: DatasetId
    url: string
    requested: number
    selected: number
  }>
  cases: BenchmarkCase[]
}

export interface UsageMetrics {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  costUsd?: number
}

export interface RetrievalMetrics {
  recallAt1: number
  recallAt3: number
  recallAt5: number
  recallAt10: number
  precisionAt5: number
  reciprocalRank: number
  averagePrecision: number
  ndcgAt10: number
  fullCoverageAt10: boolean
}

export interface FastContextRunDiagnostics {
  eventCount: number
  hitCount: number
  contextMaps?: {
    state: 'off' | 'warming' | 'on'
    confidence?: number
    nodes?: number
    elapsedMs?: number
  }
  stageDurationsMs?: {
    planner: number
    primer: number
    plannedRetrieval: number
    dependencyExpansion: number
    contextMaps: number
    judge: number
    total: number
  }
  insights: string[]
}

export type RunFailureKind =
  | 'none'
  | 'timeout'
  | 'protocol'
  | 'authentication'
  | 'rate_limit'
  | 'model'
  | 'tool'
  | 'output_contract'
  | 'repository'
  | 'unknown'

export interface RunRecord {
  runId: string
  experimentId: string
  startedAt: string
  completedAt: string
  caseId: string
  dataset: DatasetId
  repository: string
  language: string
  category: string
  system: RetrievalSystemId
  repeat: number
  order: number
  model: string | null
  reasoning: 'disabled'
  protocol: string
  success: boolean
  failureKind: RunFailureKind
  timedOut: boolean
  latencyMs: number
  apiDurationMs?: number
  apiRequests: number
  apiRetries: number
  toolCalls: number
  searchCalls: number
  readCalls: number
  rankedPaths: string[]
  readPaths: string[]
  goldPaths: string[]
  metrics: RetrievalMetrics
  usage: UsageMetrics
  repositoryFiles: number
  repositoryBytes: number
  rawOutput: string
  fastContextDiagnostics?: FastContextRunDiagnostics
  error?: string
  cliVersion?: string
}

export interface ExperimentMetadata {
  schemaVersion: 1
  experimentId: string
  createdAt: string
  gitCommit: string
  model: string
  reasoning: 'disabled'
  endpointHost: string
  manifestPath: string
  manifestSha256: string
  systems: RetrievalSystemId[]
  caseIds: string[]
  repeats: number
  concurrency?: number
  timeoutMs: number
  seed: number
  cliVersions: Record<string, string>
  notes: string[]
}

export interface RepositoryStats {
  files: number
  bytes: number
}
