import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ConversationInteractionState } from './types'

const INTERACTION_SCHEMA_VERSION = 1 as const
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

interface ConversationInteractionFileV2 {
  schemaVersion: typeof INTERACTION_SCHEMA_VERSION
  profileId: string
  conversationId: string
  updatedAt: number
  state: ConversationInteractionState
}

function assertId(label: string, value: string): string {
  if (!SAFE_ID_PATTERN.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

function emptyState(): ConversationInteractionState {
  return { queuedInputs: [], draft: { text: '' }, pendingSteering: [], pendingApprovals: [] }
}

function durableJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  const handle = openSync(temporary, 'r')
  try {
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  renameSync(temporary, path)
}

function recoverableState(value: ConversationInteractionState): ConversationInteractionState {
  return {
    queuedInputs: value.queuedInputs.map(input => structuredClone(input)),
    draft: structuredClone(value.draft),
    pendingSteering: value.pendingSteering.map(input => structuredClone(input)),
    pendingApprovals: [],
    workflow: value.workflow ? structuredClone(value.workflow) : undefined,
  }
}

export class ConversationInteractionStoreV2 {
  private readonly root: string

  constructor(
    root: string,
    private readonly profileId: string,
    private readonly now: () => number = Date.now,
  ) {
    this.root = resolve(root)
    assertId('profile identity', profileId)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }

  load(conversationId: string): ConversationInteractionState {
    const path = this.pathFor(conversationId)
    if (!existsSync(path)) return emptyState()
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ConversationInteractionFileV2>
    if (parsed.schemaVersion !== INTERACTION_SCHEMA_VERSION
      || parsed.profileId !== this.profileId
      || parsed.conversationId !== conversationId
      || !parsed.state
      || !Array.isArray(parsed.state.queuedInputs)
      || !parsed.state.draft
      || !Array.isArray(parsed.state.pendingSteering)) throw new Error('Invalid Conversation V2 interaction state')
    return recoverableState(parsed.state)
  }

  save(conversationId: string, state: ConversationInteractionState): void {
    const safeConversationId = assertId('conversation identity', conversationId)
    durableJson(this.pathFor(safeConversationId), {
      schemaVersion: INTERACTION_SCHEMA_VERSION,
      profileId: this.profileId,
      conversationId: safeConversationId,
      updatedAt: this.now(),
      state: recoverableState(state),
    } satisfies ConversationInteractionFileV2)
  }

  private pathFor(conversationId: string): string {
    return join(this.root, `${assertId('conversation identity', conversationId)}.json`)
  }
}
