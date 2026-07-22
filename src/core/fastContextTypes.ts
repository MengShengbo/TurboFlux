export type FastContextScanFileStatus = 'discovered' | 'reading' | 'absorbed' | 'skipped' | 'error'
export type FastContextScanPhase = 'mapping' | 'ranking' | 'synthesizing' | 'completed' | 'error' | 'scanning'
export type FastContextScanWorkerStatus = 'queued' | 'running' | 'completed' | 'error'
export type FastContextEvidenceKind = 'entry' | 'implementation' | 'caller' | 'config' | 'schema' | 'test' | 'root_cause' | 'supporting'
export type FastContextConfidence = 'high' | 'medium' | 'low'
export type FastContextLevel = 'low' | 'medium' | 'max'

export interface FastContextTuning {
  level: FastContextLevel
  maxTurns: number
  maxParallel: number
  taskTimeoutMs: number
  reasoningEffort: 'low' | 'medium' | 'max'
}

export function normalizeFastContextLevel(value: unknown): FastContextLevel {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'low' || normalized === 'quick') return 'low'
  if (normalized === 'max' || normalized === 'very_thorough' || normalized === 'very-thorough') return 'max'
  return 'medium'
}

export function getFastContextTuning(value: unknown = 'medium'): FastContextTuning {
  const level = normalizeFastContextLevel(value)
  if (level === 'low') {
    return { level, maxTurns: 5, maxParallel: 4, taskTimeoutMs: 180_000, reasoningEffort: 'low' }
  }
  if (level === 'max') {
    return { level, maxTurns: 12, maxParallel: 8, taskTimeoutMs: 720_000, reasoningEffort: 'max' }
  }
  return { level, maxTurns: 8, maxParallel: 6, taskTimeoutMs: 360_000, reasoningEffort: 'medium' }
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
  | { type: 'insight'; text: string; tone?: 'info' | 'success' | 'warning' }

export interface FastContextScanResult {
  objective: string
  evidencePack: string
  filesScanned: number
  hits: FastContextScanHit[]
  elapsedMs: number
  truncated: boolean
  telemetry?: {
    toolCalls: number
    searchCalls: number
    readCalls: number
  }
}
