export type FastContextScanFileStatus = 'discovered' | 'reading' | 'absorbed' | 'skipped' | 'error'
export type FastContextScanPhase = 'mapping' | 'ranking' | 'synthesizing' | 'completed' | 'error' | 'scanning'
export type FastContextScanWorkerStatus = 'queued' | 'running' | 'completed' | 'error'
export type FastContextEvidenceKind = 'entry' | 'implementation' | 'caller' | 'config' | 'schema' | 'test' | 'root_cause' | 'supporting'
export type FastContextConfidence = 'high' | 'medium' | 'low'

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
}
