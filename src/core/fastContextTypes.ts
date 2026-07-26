export type FastContextScanFileStatus = 'discovered' | 'reading' | 'absorbed' | 'skipped' | 'error'
export type FastContextScanPhase = 'mapping' | 'ranking' | 'synthesizing' | 'completed' | 'error' | 'scanning'
export type FastContextScanWorkerStatus = 'queued' | 'running' | 'completed' | 'error'
export type FastContextEvidenceKind = 'entry' | 'implementation' | 'caller' | 'config' | 'schema' | 'test' | 'root_cause' | 'supporting'
export type FastContextConfidence = 'high' | 'medium' | 'low'
export type FastContextStrategy = 'autonomous-race'

export interface FastContextTuning {
  maxTurns: number
  maxParallel: number
  taskTimeoutMs: number
}

export const FAST_CONTEXT_TUNING: Readonly<FastContextTuning> = {
  maxTurns: 6,
  maxParallel: 6,
  taskTimeoutMs: 600_000,
}

export interface FastContextProfile extends FastContextTuning {
  strategy: FastContextStrategy
  requestTimeoutMs: number
  maxCandidates: number
  reasoning: 'disabled' | 'high'
}

export const FAST_CONTEXT_PROFILES: Readonly<Record<FastContextStrategy, FastContextProfile>> = {
  'autonomous-race': {
    strategy: 'autonomous-race',
    ...FAST_CONTEXT_TUNING,
    requestTimeoutMs: 60_000,
    maxCandidates: 10,
    reasoning: 'disabled',
  },
}

export function getFastContextProfile(strategy: FastContextStrategy = 'autonomous-race'): FastContextProfile {
  return FAST_CONTEXT_PROFILES[strategy] || FAST_CONTEXT_PROFILES['autonomous-race']
}

export function normalizeFastContextStrategy(value: unknown): FastContextStrategy {
  return 'autonomous-race'
}

export interface FastContextScanHit {
  path: string
  line: number
  startLine: number
  endLine: number
  preview: string
  workerId?: string
  reason?: string
  kind?: FastContextEvidenceKind
  score?: number
  confidence?: FastContextConfidence
  symbol?: string
}

export type FastContextScanEvent =
  | { type: 'phase'; phase: FastContextScanPhase; wave?: number; maxWaves?: number; insight?: string }
  | { type: 'worker'; id: string; label: string; status: FastContextScanWorkerStatus; currentPath?: string; scannedCount?: number; hitCount?: number }
  | { type: 'file'; path: string; status: FastContextScanFileStatus; workerId?: string; reason?: string; kind?: FastContextEvidenceKind; score?: number; confidence?: FastContextConfidence }
  | { type: 'hit'; hit: FastContextScanHit }
  | { type: 'progress'; files: number; absorbed: number; hits: number; latest?: string; insight?: string }
  | { type: 'insight'; text: string; tone?: 'info' | 'success' | 'warning' }
  | { type: 'wave_metrics'; turn: number; calls: number; modelElapsedMs: number; toolElapsedMs: number; totalElapsedMs: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }

export interface FastContextScanResult {
  objective: string
  strategy?: FastContextStrategy
  evidencePack: string
  filesScanned: number
  hits: FastContextScanHit[]
  elapsedMs: number
  truncated: boolean
  telemetry?: {
    toolCalls: number
    searchCalls: number
    readCalls: number
    internalOperations?: number
    internalReadOperations?: number
    stageDurationsMs?: {
      planner: number
      primer: number
      plannedRetrieval: number
      dependencyExpansion: number
      judge: number
      total: number
    }
  }
}
