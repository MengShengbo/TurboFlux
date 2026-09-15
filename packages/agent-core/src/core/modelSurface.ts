import { createHash } from 'node:crypto'
import type { AgentAttachment, AgentTurn, ToolResult } from '../shared/agentTypes'
import {
  MODEL_SURFACE_SCHEMA_VERSION,
  type ModelSurfaceDifference,
  type ModelSurfaceReplacementReason,
  type ModelSurfaceSnapshotEvent,
  type ModelSurfaceSnapshotSource,
  type ModelSurfaceState,
} from '../shared/modelSurfaceTypes'

const MODEL_SNAPSHOT_TURN_PREFIX = 'model-surface-snapshot:'
const STALE_TOOL_RESULT_PREVIEW_CHARS = 80
const DEFAULT_MAX_DIRECT_IMAGE_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 3 * 1024 * 1024
const DEFAULT_MAX_REQUEST_IMAGES = 3

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalize(entry)]))
  }
  return value
}

export function modelSurfaceFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex')
}

function turnFingerprint(turn: AgentTurn): string {
  return modelSurfaceFingerprint({
    id: turn.id,
    role: turn.role,
    content: turn.content,
    toolCalls: turn.toolCalls,
    toolResults: turn.toolResults,
    metadata: turn.metadata,
  })
}

function projectedFingerprint(turns: readonly AgentTurn[]): string {
  return modelSurfaceFingerprint(turns.map(turnFingerprint))
}

function snapshotTurn(event: ModelSurfaceSnapshotEvent): AgentTurn {
  return {
    id: `${MODEL_SNAPSHOT_TURN_PREFIX}${event.source}:${event.revision}:${event.sequence}`,
    role: 'user',
    content: event.cleared
      ? `<model_context source="${event.source}" revision="${event.revision}" state="cleared" />`
      : [
          `<model_context source="${event.source}" revision="${event.revision}" state="current">`,
          'This snapshot supersedes earlier snapshots with the same source.',
          event.content,
          '</model_context>',
        ].join('\n'),
    timestamp: event.createdAt,
  }
}

function isSnapshotTurn(turn: AgentTurn): boolean {
  return turn.id.startsWith(MODEL_SNAPSHOT_TURN_PREFIX)
}

function appendOmission(content: string, line: string): string {
  if (content.includes(line)) return content
  return content ? `${content}\n\n${line}` : line
}

function omittedToolResult(result: ToolResult): ToolResult {
  if (result.output.startsWith('[older ') && result.output.includes('result omitted from model context;')) {
    return result
  }
  return {
    ...result,
    output: result.output.length > STALE_TOOL_RESULT_PREVIEW_CHARS
      ? `[older ${result.name} result omitted from model context; ${result.output.length} chars remain available in conversation history]`
      : result.output,
    attachments: undefined,
  }
}

function attachmentCandidates(turns: readonly AgentTurn[]): Array<{ attachment: AgentAttachment; turnIndex: number; resultIndex?: number }> {
  const candidates: Array<{ attachment: AgentAttachment; turnIndex: number; resultIndex?: number }> = []
  turns.forEach((turn, turnIndex) => {
    for (const attachment of turn.metadata?.attachments ?? []) {
      if (attachment.type === 'image') candidates.push({ attachment, turnIndex })
    }
    turn.toolResults?.forEach((result, resultIndex) => {
      for (const attachment of result.attachments ?? []) {
        if (attachment.type === 'image') candidates.push({ attachment, turnIndex, resultIndex })
      }
    })
  })
  return candidates
}

export class ModelSurface {
  private state: ModelSurfaceState = this.createEmptyState()

  constructor(state?: ModelSurfaceState, fallbackTurns: readonly AgentTurn[] = []) {
    this.restore(state, fallbackTurns)
  }

  restore(state: ModelSurfaceState | undefined, fallbackTurns: readonly AgentTurn[] = []): void {
    const restoredPersistedState = state?.schemaVersion === MODEL_SURFACE_SCHEMA_VERSION && Array.isArray(state.events)
    if (restoredPersistedState) {
      this.state = clone({
        ...state,
        replacementHistory: state.replacementHistory ?? [],
        sourceTurnIds: state.sourceTurnIds ?? [],
        sourceTurnFingerprints: state.sourceTurnFingerprints ?? [],
      })
    } else {
      this.state = this.createEmptyState()
    }
    if (!restoredPersistedState || fallbackTurns.length > 0) this.syncTurns(fallbackTurns, 'restore')
  }

  reset(turns: readonly AgentTurn[] = []): void {
    this.state = this.createEmptyState()
    this.syncTurns(turns, 'restore')
  }

  getState(): ModelSurfaceState {
    return clone(this.state)
  }

  projectTurns(): AgentTurn[] {
    let projected: AgentTurn[] = []
    for (const event of this.state.events) {
      if (event.kind === 'replacement') {
        projected = clone(event.turns)
      } else if (event.kind === 'turn') {
        projected.push(clone(event.turn))
      } else {
        projected.push(snapshotTurn(event))
      }
    }
    return projected
  }

  projectConversationTurns(): AgentTurn[] {
    return this.projectTurns().filter(turn => !isSnapshotTurn(turn))
  }

  syncTurns(turns: readonly AgentTurn[], reason: ModelSurfaceReplacementReason = 'turn_divergence'): boolean {
    const currentFingerprints = this.state.sourceTurnFingerprints
    const currentLength = currentFingerprints.length
    const shared = Math.min(currentFingerprints.length, turns.length)
    for (let index = 0; index < shared; index += 1) {
      if (currentFingerprints[index] !== turnFingerprint(turns[index]!)) {
        this.replaceConversationTurns(turns, reason)
        return true
      }
    }
    if (turns.length < currentFingerprints.length) {
      this.replaceConversationTurns(turns, reason)
      return true
    }
    for (let index = currentFingerprints.length; index < turns.length; index += 1) {
      const turn = clone(turns[index]!)
      const fingerprint = turnFingerprint(turn)
      this.state.events.push({
        kind: 'turn',
        sequence: this.nextSequence(),
        fingerprint,
        turn,
      })
      this.state.sourceTurnIds.push(turn.id)
      this.state.sourceTurnFingerprints.push(fingerprint)
    }
    return turns.length > currentLength
  }

  appendSnapshot(source: ModelSurfaceSnapshotSource, content: string | null | undefined, createdAt = Date.now()): boolean {
    const normalizedContent = content?.trim() ?? ''
    const cleared = normalizedContent.length === 0
    const fingerprint = modelSurfaceFingerprint({ source, content: normalizedContent, cleared })
    const previous = this.state.snapshotHeads[source]
    if (previous?.fingerprint === fingerprint) return false
    if (!previous && cleared) return false

    const revision = (previous?.revision ?? 0) + 1
    this.state.events.push({
      kind: 'snapshot',
      sequence: this.nextSequence(),
      source,
      revision,
      fingerprint,
      content: normalizedContent,
      cleared,
      createdAt,
    })
    this.state.snapshotHeads[source] = { fingerprint, revision, cleared }
    return true
  }

  replaceConversationTurns(turns: readonly AgentTurn[], reason: ModelSurfaceReplacementReason): void {
    this.state.sourceTurnIds = turns.map(turn => turn.id)
    this.state.sourceTurnFingerprints = turns.map(turnFingerprint)
    const snapshots = this.projectTurns().filter(isSnapshotTurn)
    this.replaceProjectedTurns([...clone(turns), ...snapshots], reason)
  }

  replaceProjectedTurns(turns: readonly AgentTurn[], reason: ModelSurfaceReplacementReason): void {
    const previous = this.projectTurns()
    const next = clone([...turns])
    this.state.generation += 1
    const replacement = {
      kind: 'replacement',
      sequence: this.nextSequence(),
      generation: this.state.generation,
      reason,
      previousFingerprint: projectedFingerprint(previous),
      nextFingerprint: projectedFingerprint(next),
      turns: next,
      createdAt: Date.now(),
    } as const
    this.state.events = [replacement]
    this.state.replacementHistory.push({
      sequence: replacement.sequence,
      generation: replacement.generation,
      reason: replacement.reason,
      previousFingerprint: replacement.previousFingerprint,
      nextFingerprint: replacement.nextFingerprint,
      createdAt: replacement.createdAt,
    })
    if (this.state.replacementHistory.length > 64) {
      this.state.replacementHistory = this.state.replacementHistory.slice(-64)
    }
  }

  pruneStaleToolResults(activeWorkRunId?: string): boolean {
    const turns = this.projectTurns()
    let latestUserIndex = -1
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (turns[index]?.role === 'user' && !isSnapshotTurn(turns[index]!)) {
        latestUserIndex = index
        break
      }
    }
    if (turns.length < 4 || latestUserIndex < 0) return false

    let changed = false
    for (let index = turns.length - 3; index >= 0; index -= 1) {
      const turn = turns[index]!
      if (turn.role !== 'tool_result' || !turn.toolResults || index > latestUserIndex) continue
      if (activeWorkRunId && turn.metadata?.workRunId === activeWorkRunId) continue

      const hasActiveReference = turns.slice(index + 1).some(laterTurn => {
        if (laterTurn.role !== 'assistant') return false
        const content = laterTurn.content.toLowerCase()
        return turn.toolResults!.some(result => {
          if (content.includes(result.toolCallId.toLowerCase())) return true
          if (result.output.length > 40 && content.includes(result.output.slice(0, 40).toLowerCase())) return true
          const path = result.changeSummary?.path
          return Boolean(path && content.includes(path.toLowerCase()))
        })
      })
      if (hasActiveReference) continue

      const nextResults = turn.toolResults.map(omittedToolResult)
      if (nextResults.some((result, resultIndex) => result !== turn.toolResults![resultIndex])) {
        turns[index] = { ...turn, toolResults: nextResults }
        changed = true
      }
    }
    if (changed) this.replaceProjectedTurns(turns, 'tool_result_pruning')
    return changed
  }

  enforceImageBudget(options: { maxImages?: number; maxImageBytes?: number; maxTotalBytes?: number } = {}): boolean {
    const maxImages = options.maxImages ?? DEFAULT_MAX_REQUEST_IMAGES
    const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_DIRECT_IMAGE_BYTES
    const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES
    const turns = this.projectTurns()
    const candidates = attachmentCandidates(turns)
    const selected = new Set<string>()
    let totalBytes = 0
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const attachment = candidates[index]!.attachment
      if (selected.size >= maxImages) break
      if (attachment.size <= 0 || attachment.size > maxImageBytes || totalBytes + attachment.size > maxTotalBytes) continue
      selected.add(attachment.id)
      totalBytes += attachment.size
    }

    let changed = false
    turns.forEach((turn, turnIndex) => {
      const omittedUserImages = (turn.metadata?.attachments ?? []).filter(attachment => attachment.type === 'image' && !selected.has(attachment.id))
      if (omittedUserImages.length > 0) {
        const kept = (turn.metadata?.attachments ?? []).filter(attachment => attachment.type !== 'image' || selected.has(attachment.id))
        const lines = omittedUserImages.map(attachment => `[Earlier image omitted by an explicit model-context replacement: ${attachment.filename} (${attachment.mime})]`)
        turns[turnIndex] = {
          ...turn,
          content: lines.reduce(appendOmission, turn.content),
          metadata: { ...turn.metadata, attachments: kept.length > 0 ? kept : undefined },
        }
        changed = true
      }

      const current = turns[turnIndex]!
      if (!current.toolResults) return
      const nextResults = current.toolResults.map(result => {
        const omitted = (result.attachments ?? []).filter(attachment => attachment.type === 'image' && !selected.has(attachment.id))
        if (omitted.length === 0) return result
        changed = true
        const kept = (result.attachments ?? []).filter(attachment => attachment.type !== 'image' || selected.has(attachment.id))
        return {
          ...result,
          output: omitted.reduce(
            (output, attachment) => appendOmission(output, `[Earlier visual evidence omitted by an explicit model-context replacement: ${attachment.filename} (${attachment.mime})]`),
            result.output,
          ),
          attachments: kept.length > 0 ? kept : undefined,
        }
      })
      if (nextResults.some((result, resultIndex) => result !== current.toolResults![resultIndex])) {
        turns[turnIndex] = { ...current, toolResults: nextResults }
      }
    })

    if (changed) this.replaceProjectedTurns(turns, 'image_budget')
    return changed
  }

  firstDifference(previous: readonly AgentTurn[]): ModelSurfaceDifference | null {
    const next = this.projectTurns()
    const length = Math.max(previous.length, next.length)
    for (let index = 0; index < length; index += 1) {
      const previousTurn = previous[index]
      const nextTurn = next[index]
      const previousFingerprint = previousTurn ? turnFingerprint(previousTurn) : undefined
      const nextFingerprint = nextTurn ? turnFingerprint(nextTurn) : undefined
      if (previousFingerprint !== nextFingerprint) {
        return {
          index,
          previousFingerprint,
          nextFingerprint,
          previousTurnId: previousTurn?.id,
          nextTurnId: nextTurn?.id,
        }
      }
    }
    return null
  }

  private createEmptyState(): ModelSurfaceState {
    return {
      schemaVersion: MODEL_SURFACE_SCHEMA_VERSION,
      generation: 0,
      nextSequence: 1,
      events: [],
      snapshotHeads: {},
      replacementHistory: [],
      sourceTurnIds: [],
      sourceTurnFingerprints: [],
    }
  }

  private nextSequence(): number {
    const sequence = this.state.nextSequence
    this.state.nextSequence += 1
    return sequence
  }
}
