import type { AgentStateProvider, ContextCompactionState, ContextReservoirEntry, ContextSegment } from '@turboflux/contracts/stateTypes'
import type { AgentTurn } from '@turboflux/contracts/agentTypes'
import { ContextManager } from '../contextManager'
import { ModelSurface } from '@turboflux/models/modelSurface'
import type { ModelSurfaceState } from '@turboflux/contracts/modelSurfaceTypes'

export interface PreservedContextFile {
  path: string
  content: string
}

export type ContextCompactionEventType =
  | 'context:compaction_started'
  | 'context:compaction_summarizing'
  | 'context:compaction_fallback'
  | 'context:compaction_committing'
  | 'context:compaction_completed'
  | 'context:compaction_interrupted'
  | 'context:compaction_failed'
  | 'context:compaction_progress'

interface AgentContextCoordinatorOptions {
  onCompactionEvent?: (eventType: ContextCompactionEventType, state: ContextCompactionState) => void
  heartbeatMs?: number
  now?: () => number
}

interface ContextCompactionScope {
  signal: AbortSignal
  close: () => void
}

interface PrepareModelSurfaceOptions {
  modelSurface: ModelSurface
  candidateTurns: AgentTurn[]
  workExecutionContext: string
  activatedSkills?: Array<{ id: string; content: string }>
  preservedFilesContext?: string
  currentRunId?: string
  supportsVision: boolean
}

interface PreparedModelSurface {
  turns: AgentTurn[]
  state: ModelSurfaceState
}

export class AgentContextCoordinator {
  readonly manager = new ContextManager()
  private preservedContextFiles: PreservedContextFile[] = []
  private preparedTurnCount = 0
  private forceCompactionBeforeNextCall = false
  private contextLimitRetry = false
  private compactionState: ContextCompactionState | null = null
  private compactionPromise: Promise<boolean> | null = null
  private compactionAbortController: AbortController | null = null
  private compactionHeartbeat: ReturnType<typeof setInterval> | null = null

  private readonly heartbeatMs: number
  private readonly now: () => number

  constructor(
    private readonly stateProvider: AgentStateProvider,
    private readonly options: AgentContextCoordinatorOptions = {},
  ) {
    this.heartbeatMs = options.heartbeatMs ?? 1_500
    this.now = options.now ?? Date.now
  }

  isCompacting(): boolean {
    return this.compactionPromise !== null
      || (this.compactionState?.phase !== undefined
        && !['completed', 'interrupted', 'failed'].includes(this.compactionState.phase))
  }

  getSegments(): ContextSegment[] {
    return this.stateProvider.getContextSegments()
  }

  setSegments(segments: ContextSegment[]): void {
    this.stateProvider.setContextSegments(segments)
  }

  getReservoir(): ContextReservoirEntry[] {
    return this.stateProvider.getContextReservoir()
  }

  setReservoir(entries: ContextReservoirEntry[]): void {
    this.stateProvider.setContextReservoir(entries)
  }

  collectPreservedFiles(turns: AgentTurn[]): PreservedContextFile[] {
    const pathByToolCallId = new Map<string, string>()
    for (const turn of turns) {
      if (turn.role !== 'assistant' || !turn.toolCalls) continue
      for (const call of turn.toolCalls) {
        if ((call.name === 'read_file' || call.name === 'read_file_full') && typeof call.arguments.path === 'string') {
          pathByToolCallId.set(call.id, call.arguments.path)
        }
      }
    }
    const preserved: PreservedContextFile[] = []
    const seenPaths = new Set<string>()
    const maxFiles = 5
    const maxChars = 20_000
    for (let index = turns.length - 1; index >= 0 && preserved.length < maxFiles; index -= 1) {
      const turn = turns[index]
      if (turn.role !== 'tool_result' || !turn.toolResults) continue
      for (const result of turn.toolResults) {
        if (result.name !== 'read_file' && result.name !== 'read_file_full') continue
        const path = pathByToolCallId.get(result.toolCallId)
        if (!path || seenPaths.has(path)) continue
        seenPaths.add(path)
        const content = result.output.length > maxChars
          ? `${result.output.slice(0, maxChars)}\n<recent_file_truncated />`
          : result.output
        preserved.push({ path, content })
        if (preserved.length >= maxFiles) break
      }
    }
    return preserved.reverse()
  }

  addReservoirEntry(
    startMessageId: string,
    endMessageId: string,
    turns: AgentTurn[],
    source: ContextReservoirEntry['source'],
    countTurnChars: (turn: AgentTurn) => number,
    originalCharCount = turns.reduce((sum, turn) => sum + countTurnChars(turn), 0),
  ): void {
    if (turns.length === 0) return
    this.stateProvider.addContextReservoirEntry({
      id: `reservoir-${startMessageId}-${endMessageId}`,
      startMessageId,
      endMessageId,
      turns: turns.map(turn => ({ ...turn })),
      source,
      originalCharCount,
      createdAt: this.now(),
    })
    this.pruneReservoir(countTurnChars)
  }

  prepareModelSurface(options: PrepareModelSurfaceOptions): PreparedModelSurface {
    options.modelSurface.syncTurns(options.candidateTurns)
    options.modelSurface.appendSnapshot('work_execution', options.workExecutionContext)
    const activeSkillSources = new Set((options.activatedSkills ?? []).map(skill => `activated_skill:${skill.id}`))
    for (const source of Object.keys(options.modelSurface.getState().snapshotHeads)) {
      if (source.startsWith('activated_skill:') && !activeSkillSources.has(source)) {
        options.modelSurface.appendSnapshot(source, null)
      }
    }
    for (const skill of options.activatedSkills ?? []) {
      options.modelSurface.appendSnapshot(`activated_skill:${skill.id}`, skill.content)
    }
    if (options.preservedFilesContext) {
      options.modelSurface.appendSnapshot('compaction_files', options.preservedFilesContext)
    }
    // A new user request is not a context-pressure signal. Retain the exact
    // previously sent tool results until explicit compaction or the model's
    // input budget requires a replacement, so follow-ups keep their prefix.
    if (options.supportsVision) options.modelSurface.enforceImageBudget()
    return {
      turns: options.modelSurface.projectTurns(),
      state: options.modelSurface.getState(),
    }
  }

  private pruneReservoir(countTurnChars: (turn: AgentTurn) => number): void {
    const maxEntries = 24
    const maxChars = 2_500_000
    const entries = this.stateProvider.getContextReservoir()
      .slice()
      .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    const kept: ContextReservoirEntry[] = []
    let totalChars = 0
    for (const entry of entries) {
      const chars = entry.originalCharCount || entry.turns.reduce((sum, turn) => sum + countTurnChars(turn), 0)
      if (kept.length >= maxEntries || totalChars + chars > maxChars) continue
      kept.push(entry)
      totalChars += chars
    }
    this.stateProvider.setContextReservoir(kept.sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0)))
  }

  getCompactionState(): ContextCompactionState | null {
    const persisted = this.stateProvider.getContextCompactionState?.()
    const state = persisted ?? this.compactionState
    return state ? { ...state } : null
  }

  setCompactionState(state: ContextCompactionState | null): void {
    this.compactionState = state ? { ...state } : null
    this.stateProvider.setContextCompactionState?.(state ? { ...state } : null)
    this.forceCompactionBeforeNextCall = state?.phase === 'interrupted' && state.recoverable
  }

  async runCompaction(operation: () => Promise<boolean>): Promise<boolean> {
    if (this.compactionPromise) return this.compactionPromise
    const promise = operation()
    this.compactionPromise = promise
    try {
      return await promise
    } finally {
      if (this.compactionPromise === promise) this.compactionPromise = null
    }
  }

  beginCompaction(
    initialState: ContextCompactionState,
    linkOperation?: (controller: AbortController) => () => void,
  ): ContextCompactionScope {
    this.compactionAbortController = new AbortController()
    const unlinkOperation = linkOperation?.(this.compactionAbortController) ?? (() => undefined)
    this.compactionState = { ...initialState }
    this.stateProvider.setContextCompactionState?.({ ...initialState })
    this.options.onCompactionEvent?.('context:compaction_started', { ...initialState })
    this.startHeartbeat()
    return {
      signal: this.compactionAbortController.signal,
      close: () => {
        unlinkOperation()
        this.stopHeartbeat()
        this.compactionAbortController = null
      },
    }
  }

  updateCompactionState(
    phase: ContextCompactionState['phase'],
    patch: Partial<ContextCompactionState>,
    eventType: ContextCompactionEventType,
  ): void {
    const current = this.compactionState
    if (!current) return
    const updatedAt = this.now()
    const next: ContextCompactionState = {
      ...current,
      ...patch,
      phase,
      updatedAt,
      elapsedMs: Math.max(0, updatedAt - current.startedAt),
    }
    this.compactionState = next
    this.stateProvider.setContextCompactionState?.({ ...next })
    this.options.onCompactionEvent?.(eventType, { ...next })
  }

  abortCompaction(): void {
    this.compactionAbortController?.abort()
  }

  getCompactionSignal(): AbortSignal | undefined {
    return this.compactionAbortController?.signal
  }

  createCompactionAbortError(): Error & { aborted: boolean } {
    const error = new Error('Context compaction aborted') as Error & { aborted: boolean }
    error.aborted = true
    return error
  }

  resetSessionState(): void {
    this.setCompactionState(null)
    this.forceCompactionBeforeNextCall = false
    this.contextLimitRetry = false
    this.preparedTurnCount = 0
    this.preservedContextFiles = []
  }

  destroy(): void {
    this.compactionAbortController?.abort()
    if (this.compactionHeartbeat) clearInterval(this.compactionHeartbeat)
    this.compactionHeartbeat = null
    this.compactionAbortController = null
    // runCompaction releases ownership when the cancelled operation actually settles.
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.compactionHeartbeat = setInterval(() => {
      const phase = this.compactionState?.phase
      if (!phase || ['completed', 'interrupted', 'failed'].includes(phase)) return
      this.updateCompactionState(phase, {}, 'context:compaction_progress')
    }, this.heartbeatMs)
  }

  private stopHeartbeat(): void {
    if (this.compactionHeartbeat) clearInterval(this.compactionHeartbeat)
    this.compactionHeartbeat = null
  }

  get preservedFiles(): PreservedContextFile[] {
    return this.preservedContextFiles
  }

  set preservedFiles(files: PreservedContextFile[]) {
    this.preservedContextFiles = files
  }

  get compressionPreparedTurnCount(): number {
    return this.preparedTurnCount
  }

  set compressionPreparedTurnCount(value: number) {
    this.preparedTurnCount = value
  }

  get forceContextCompactionBeforeNextCall(): boolean {
    return this.forceCompactionBeforeNextCall
  }

  set forceContextCompactionBeforeNextCall(value: boolean) {
    this.forceCompactionBeforeNextCall = value
  }

  get contextLimitRetryInProgress(): boolean {
    return this.contextLimitRetry
  }

  set contextLimitRetryInProgress(value: boolean) {
    this.contextLimitRetry = value
  }

  get contextCompactionState(): ContextCompactionState | null {
    return this.compactionState
  }

  set contextCompactionState(state: ContextCompactionState | null) {
    this.compactionState = state
  }

  get contextCompactionPromise(): Promise<boolean> | null {
    return this.compactionPromise
  }

  set contextCompactionPromise(promise: Promise<boolean> | null) {
    this.compactionPromise = promise
  }

  get contextCompactionAbortController(): AbortController | null {
    return this.compactionAbortController
  }

  set contextCompactionAbortController(controller: AbortController | null) {
    this.compactionAbortController = controller
  }

  get contextCompactionHeartbeat(): ReturnType<typeof setInterval> | null {
    return this.compactionHeartbeat
  }

  set contextCompactionHeartbeat(heartbeat: ReturnType<typeof setInterval> | null) {
    this.compactionHeartbeat = heartbeat
  }
}
