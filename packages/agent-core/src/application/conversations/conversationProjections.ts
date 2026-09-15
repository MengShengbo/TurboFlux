import type {
  AnyConversationEventV2,
  ConversationItemV2,
  ConversationRunV2,
  ConversationTranscriptProjectionV2,
  ConversationTurnV2,
  ConversationArtifactProjectionV2,
} from './conversationV2Types'

function clone<T>(value: T): T {
  return structuredClone(value)
}

export function projectConversationEvents(events: readonly AnyConversationEventV2[]): ConversationTranscriptProjectionV2 {
  const projection: ConversationTranscriptProjectionV2 = {
    conversation: null,
    runs: [],
    turns: [],
    items: [],
    timeline: [],
    artifacts: [],
    workspace: null,
    queuedInputIds: [],
    throughSeq: 0,
  }
  const runById = new Map<string, ConversationRunV2>()
  const turnById = new Map<string, ConversationTurnV2>()
  const itemById = new Map<string, ConversationItemV2>()
  const artifactById = new Map<string, ConversationArtifactProjectionV2>()
  let previousSeq = 0
  let workspaceRequired = false

  for (const event of events) {
    if (event.seq <= previousSeq) throw new Error(`Conversation event sequence is not strictly increasing at ${event.seq}`)
    previousSeq = event.seq
    projection.throughSeq = event.seq
    projection.timeline.push({
      eventId: event.eventId,
      seq: event.seq,
      at: event.at,
      type: event.type,
      runId: event.runId,
      turnId: event.turnId,
      itemId: event.itemId,
    })
    switch (event.type) {
      case 'conversation.created':
        projection.conversation = clone(event.payload.record)
        workspaceRequired = event.payload.record.status === 'needs_workspace'
        break
      case 'conversation.renamed':
        if (projection.conversation) Object.assign(projection.conversation, event.payload, { updatedAt: event.at })
        break
      case 'conversation.configuration_changed':
        if (projection.conversation) Object.assign(projection.conversation, event.payload, { updatedAt: event.at })
        break
      case 'conversation.rewritten': {
        const retainedTurnIds = new Set(event.payload.retainedTurnIds)
        const retainedRunIds = new Set(projection.turns
          .filter(turn => retainedTurnIds.has(turn.id) && turn.runId)
          .map(turn => turn.runId!))
        projection.turns = projection.turns.filter(turn => retainedTurnIds.has(turn.id))
        projection.runs = projection.runs.filter(run => retainedRunIds.has(run.id))
        projection.items = projection.items.filter(item => (
          item.turnId ? retainedTurnIds.has(item.turnId) : !item.runId || retainedRunIds.has(item.runId)
        ))
        turnById.clear()
        for (const turn of projection.turns) turnById.set(turn.id, turn)
        runById.clear()
        for (const run of projection.runs) runById.set(run.id, run)
        itemById.clear()
        for (const item of projection.items) itemById.set(item.id, item)
        const retainedItemIds = new Set(projection.items.map(item => item.id))
        projection.artifacts = projection.artifacts
          .map(artifact => ({ ...artifact, itemIds: artifact.itemIds.filter(id => retainedItemIds.has(id)) }))
          .filter(artifact => artifact.itemIds.length > 0)
        artifactById.clear()
        for (const artifact of projection.artifacts) artifactById.set(artifact.artifactId, artifact)
        if (projection.conversation) {
          projection.conversation.status = projection.conversation.workspaceId ? 'idle' : 'needs_workspace'
          projection.conversation.updatedAt = event.payload.rewrittenAt
        }
        break
      }
      case 'conversation.archived':
        if (projection.conversation) Object.assign(projection.conversation, { status: 'archived' as const, archivedAt: event.payload.archivedAt, updatedAt: event.at })
        break
      case 'conversation.restored':
        if (projection.conversation) {
          projection.conversation.status = projection.conversation.workspaceId ? 'idle' : 'needs_workspace'
          delete projection.conversation.archivedAt
          projection.conversation.updatedAt = event.at
        }
        break
      case 'conversation.workspace_changed':
        workspaceRequired = event.payload.status === 'needs_workspace'
        if (projection.conversation) Object.assign(projection.conversation, event.payload, { updatedAt: event.at })
        break
      case 'run.started': {
        const run = clone(event.payload.run)
        const existing = runById.get(run.id)
        if (existing) Object.assign(existing, run)
        else {
          runById.set(run.id, run)
          projection.runs.push(run)
        }
        if (projection.conversation) projection.conversation.status = 'active'
        break
      }
      case 'run.state_changed': {
        const run = event.runId ? runById.get(event.runId) : undefined
        if (run) Object.assign(run, clone(event.payload))
        break
      }
      case 'run.completed': {
        const run = event.runId ? runById.get(event.runId) : undefined
        if (run) Object.assign(run, clone(event.payload), { updatedAt: event.payload.completedAt })
        if (projection.conversation && !projection.runs.some(candidate => candidate.status === 'running' || candidate.status === 'waiting')) {
          projection.conversation.status = workspaceRequired || !projection.conversation.workspaceId ? 'needs_workspace' : 'idle'
        }
        break
      }
      case 'run.recovered': {
        const run = event.runId ? runById.get(event.runId) : undefined
        const segment = run?.executionSegments?.at(-1)
        if (run && segment && segment.endedAt === undefined) {
          segment.endedAt = Math.max(segment.startedAt, run.updatedAt)
          segment.outcome = 'interrupted'
        }
        if (run) Object.assign(run, { status: 'interrupted' as const, updatedAt: event.payload.recoveredAt, completedAt: event.payload.recoveredAt, recoveredFromPersistence: true })
        if (projection.conversation && !projection.runs.some(candidate => candidate.status === 'running' || candidate.status === 'waiting')) {
          projection.conversation.status = workspaceRequired || !projection.conversation.workspaceId ? 'needs_workspace' : 'idle'
        }
        break
      }
      case 'turn.started': {
        const turn = clone(event.payload.turn)
        const existing = turnById.get(turn.id)
        if (existing) Object.assign(existing, turn)
        else {
          turnById.set(turn.id, turn)
          projection.turns.push(turn)
        }
        break
      }
      case 'turn.completed': {
        const turn = event.turnId ? turnById.get(event.turnId) : undefined
        if (turn) Object.assign(turn, { status: event.payload.interrupted ? 'interrupted' as const : 'completed' as const, completedAt: event.payload.completedAt })
        break
      }
      case 'item.created': {
        const item = clone(event.payload.item)
        const hasSemanticIdentity = ((item.kind === 'user_message' || item.kind === 'assistant_message') && Boolean(item.turnId))
          || item.kind === 'tool_call' || item.kind === 'tool_result' || item.kind === 'artifact'
        const semanticDuplicate = hasSemanticIdentity ? projection.items.find(candidate => {
          if (candidate.kind !== item.kind) return false
          if ((item.kind === 'user_message' || item.kind === 'assistant_message') && item.turnId) {
            return candidate.turnId === item.turnId
          }
          if (item.kind === 'tool_call' && candidate.kind === 'tool_call') {
            return candidate.payload.toolCallId === item.payload.toolCallId
          }
          if (item.kind === 'tool_result' && candidate.kind === 'tool_result') {
            return candidate.payload.toolCallId === item.payload.toolCallId
          }
          if (item.kind === 'artifact' && candidate.kind === 'artifact') {
            return candidate.payload.artifactId === item.payload.artifactId
          }
          return false
        }) : undefined
        const existing = itemById.get(item.id) ?? semanticDuplicate
        if (existing) {
          const retainedId = existing.id
          Object.assign(existing, item, { id: retainedId })
          itemById.set(item.id, existing)
        }
        else {
          itemById.set(item.id, item)
          projection.items.push(item)
        }
        break
      }
      case 'item.updated': {
        const item = event.itemId ? itemById.get(event.itemId) : undefined
        if (item) {
          item.status = event.payload.status ?? item.status
          item.updatedAt = event.payload.updatedAt
          if (event.payload.payload) item.payload = clone(event.payload.payload) as never
        }
        break
      }
      case 'item.completed': {
        const item = event.itemId ? itemById.get(event.itemId) : undefined
        if (item) Object.assign(item, { status: event.payload.status, updatedAt: event.payload.completedAt })
        break
      }
      case 'item.redacted': {
        const item = event.itemId ? itemById.get(event.itemId) : undefined
        if (item) {
          item.status = 'redacted'
          item.updatedAt = event.payload.redactedAt
          item.payload = { omitted: true, summary: event.payload.reason } as never
        }
        break
      }
      case 'input.queued':
        if (!projection.queuedInputIds.includes(event.payload.inputId)) projection.queuedInputIds.push(event.payload.inputId)
        break
      case 'input.committed':
      case 'input.removed':
        projection.queuedInputIds = projection.queuedInputIds.filter(id => id !== event.payload.inputId)
        break
      case 'approval.requested': {
        const item: ConversationItemV2 = {
          schemaVersion: 1,
          id: `approval-${event.payload.requestId}`,
          conversationId: event.conversationId,
          runId: event.runId,
          turnId: event.turnId,
          kind: 'approval',
          status: 'pending',
          createdAt: event.at,
          updatedAt: event.at,
          payload: {
            requestId: event.payload.requestId,
            requestKind: event.payload.requestKind,
            question: event.payload.question,
          },
        }
        itemById.set(item.id, item)
        projection.items.push(item)
        break
      }
      case 'approval.resolved': {
        const item = itemById.get(`approval-${event.payload.requestId}`)
        if (item?.kind === 'approval') {
          item.status = 'completed'
          item.updatedAt = event.at
          item.payload.decision = event.payload.decision
        }
        break
      }
      case 'approval.cancelled': {
        const item = itemById.get(`approval-${event.payload.requestId}`)
        if (item?.kind === 'approval') {
          item.status = 'cancelled'
          item.updatedAt = event.at
        }
        break
      }
      case 'context.compaction_started': {
        const item: ConversationItemV2 = {
          schemaVersion: 1,
          id: `compaction-${event.payload.compactionId}`,
          conversationId: event.conversationId,
          runId: event.runId,
          kind: 'context_compaction',
          status: 'running',
          createdAt: event.at,
          updatedAt: event.at,
          payload: { sourceItemIds: [...event.payload.sourceItemIds] },
        }
        itemById.set(item.id, item)
        projection.items.push(item)
        break
      }
      case 'context.compaction_committed': {
        const item = itemById.get(`compaction-${event.payload.compactionId}`)
        if (item?.kind === 'context_compaction') {
          item.status = 'completed'
          item.updatedAt = event.at
          if (event.payload.summary !== undefined) item.payload.summary = event.payload.summary
          if (event.payload.model !== undefined) item.payload.model = event.payload.model
        }
        break
      }
      case 'context.compaction_failed': {
        const item = itemById.get(`compaction-${event.payload.compactionId}`)
        if (item?.kind === 'context_compaction') {
          item.status = 'failed'
          item.updatedAt = event.at
          item.payload.error = event.payload.error
        }
        break
      }
      case 'artifact.registered': {
        const artifact = artifactById.get(event.payload.artifactId) ?? {
          artifactId: event.payload.artifactId,
          itemIds: [],
          status: 'available' as const,
          updatedAt: event.at,
        }
        if (!artifact.itemIds.includes(event.payload.itemId)) artifact.itemIds.push(event.payload.itemId)
        artifact.status = 'available'
        artifact.updatedAt = event.at
        delete artifact.reason
        if (!artifactById.has(artifact.artifactId)) {
          artifactById.set(artifact.artifactId, artifact)
          projection.artifacts.push(artifact)
        }
        if (itemById.has(event.payload.itemId)) break
        const item: ConversationItemV2 = {
          schemaVersion: 1,
          id: event.payload.itemId,
          conversationId: event.conversationId,
          runId: event.runId,
          turnId: event.turnId,
          kind: 'artifact',
          status: 'completed',
          createdAt: event.at,
          updatedAt: event.at,
          payload: { artifactId: event.payload.artifactId, name: event.payload.artifactId },
        }
        itemById.set(item.id, item)
        projection.items.push(item)
        break
      }
      case 'artifact.linked': {
        const artifact = artifactById.get(event.payload.artifactId) ?? {
          artifactId: event.payload.artifactId,
          itemIds: [],
          status: 'available' as const,
          updatedAt: event.at,
        }
        if (!artifact.itemIds.includes(event.payload.itemId)) artifact.itemIds.push(event.payload.itemId)
        artifact.updatedAt = event.at
        if (!artifactById.has(artifact.artifactId)) {
          artifactById.set(artifact.artifactId, artifact)
          projection.artifacts.push(artifact)
        }
        break
      }
      case 'artifact.missing': {
        const artifact = artifactById.get(event.payload.artifactId) ?? {
          artifactId: event.payload.artifactId,
          itemIds: [],
          status: 'missing' as const,
          updatedAt: event.at,
        }
        artifact.status = 'missing'
        artifact.reason = event.payload.reason
        artifact.updatedAt = event.at
        if (!artifactById.has(artifact.artifactId)) {
          artifactById.set(artifact.artifactId, artifact)
          projection.artifacts.push(artifact)
        }
        for (const itemId of artifact.itemIds) {
          const item = itemById.get(itemId)
          if (item?.kind === 'artifact') {
            item.status = 'failed'
            item.updatedAt = event.at
          }
        }
        break
      }
      case 'workspace.binding_changed': {
        workspaceRequired = event.payload.state !== 'bound'
        projection.workspace = {
          workspaceId: event.payload.workspaceId,
          bindingState: event.payload.state,
          verificationState: event.payload.state === 'unbound' ? 'missing' : event.payload.state,
          updatedAt: event.payload.at,
        }
        if (projection.conversation) {
          projection.conversation.workspaceId = event.payload.workspaceId
          if (event.payload.state !== 'bound') projection.conversation.status = 'needs_workspace'
          else if (projection.conversation.status !== 'active') projection.conversation.status = 'idle'
          projection.conversation.updatedAt = event.payload.at
        }
        break
      }
      case 'workspace.verification_changed': {
        workspaceRequired = event.payload.state !== 'bound'
        const bindingState = projection.workspace?.bindingState
          ?? (event.payload.state === 'verifying' ? 'unbound' : event.payload.state)
        projection.workspace = {
          workspaceId: event.payload.workspaceId,
          bindingState,
          verificationState: event.payload.state,
          updatedAt: event.payload.at,
        }
        if (projection.conversation && event.payload.state !== 'bound') {
          projection.conversation.status = 'needs_workspace'
          projection.conversation.updatedAt = event.payload.at
        }
        break
      }
      case 'recovery.detected': {
        const item: ConversationItemV2 = {
          schemaVersion: 1,
          id: `recovery-${event.eventId}`,
          conversationId: event.conversationId,
          runId: event.runId,
          kind: 'recovery',
          status: 'completed',
          createdAt: event.at,
          updatedAt: event.at,
          payload: {
            reason: event.payload.reason,
            repairedThroughSeq: event.payload.throughSeq,
            preservedCorruptCopy: event.payload.preservedCorruptCopy,
          },
        }
        itemById.set(item.id, item)
        projection.items.push(item)
        break
      }
      case 'recovery.applied':
        break
    }
  }

  if (projection.conversation) {
    projection.conversation.lastEventSeq = projection.throughSeq
    projection.conversation.turnCount = projection.turns.length
    projection.conversation.runCount = projection.runs.length
    projection.conversation.updatedAt = Math.max(projection.conversation.updatedAt, events.at(-1)?.at ?? 0)
  }
  return projection
}
