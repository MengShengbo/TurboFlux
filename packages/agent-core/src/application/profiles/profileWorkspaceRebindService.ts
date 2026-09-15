import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { writeFileAtomicSync } from '../../core/fileIO'
import { ConversationRepositoryV2 } from '../conversations/conversationRepositoryV2'
import { ConversationStore } from '../conversations/store'
import type { ProfileStorageLayout } from './types'
import {
  WorkspaceBindingService,
  type WorkspaceBindingRecord,
} from './workspaceBindingService'

interface CollectionDocument {
  schemaVersion: number
  [key: string]: unknown
}

export interface ProfileWorkspaceRebindResult {
  workspace: WorkspaceBindingRecord
  requiresMismatchConfirmation: boolean
  updated: {
    conversations: number
    projects: number
    artifacts: number
    automations: number
  }
  automationsRemainDisabled: true
}

function unboundWorkspacePath(workspaceId: string): string {
  return `turboflux-unbound:${workspaceId}`
}

function readCollection(path: string, key: string): CollectionDocument | null {
  if (!existsSync(path)) return null
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid profile document: ${basename(path)}`)
  const document = value as CollectionDocument
  if (!Array.isArray(document[key])) throw new Error(`Invalid ${key} collection: ${basename(path)}`)
  return document
}

function rewriteCollection(
  path: string,
  key: string,
  rewrite: (record: Record<string, unknown>) => boolean,
): number {
  const document = readCollection(path, key)
  if (!document) return 0
  let updated = 0
  for (const value of document[key] as unknown[]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    if (rewrite(value as Record<string, unknown>)) updated += 1
  }
  if (updated > 0) writeFileAtomicSync(path, `${JSON.stringify(document, null, 2)}\n`, 0o600)
  return updated
}

export class ProfileWorkspaceRebindService {
  private readonly bindings: WorkspaceBindingService
  private readonly now: () => number

  constructor(
    private readonly layout: ProfileStorageLayout,
    now: () => number = Date.now,
  ) {
    this.now = now
    this.bindings = new WorkspaceBindingService(layout, now)
  }

  private rebindV2Conversations(workspaceId: string): number | null {
    const eventsRoot = join(this.layout.conversationsV2Root, 'events')
    if (!existsSync(eventsRoot)) return null
    const repository = new ConversationRepositoryV2(this.layout.conversationsV2Root, this.now)
    repository.rebuildCatalog()
    let cursor: string | undefined
    let updated = 0
    do {
      const page = repository.list({ workspaceId, cursor, limit: 200 })
      for (const conversation of page.conversations) {
        const projection = repository.projection(conversation.id)
        if (projection.workspace?.bindingState === 'bound') continue
        const at = this.now()
        repository.append([{
          profileId: this.layout.profileId,
          conversationId: conversation.id,
          workspaceId,
          source: 'runtime',
          provenance: 'live',
          type: 'workspace.binding_changed',
          at,
          payload: { workspaceId, state: 'bound', at },
        }])
        updated += 1
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return updated
  }

  rebind(input: { workspaceId: string; localPath: string; acceptMismatch?: boolean }): ProfileWorkspaceRebindResult {
    const localPath = resolve(input.localPath)
    const workspace = this.bindings.bind(input.workspaceId, localPath, input.acceptMismatch === true)
    if (workspace.state !== 'bound' || !workspace.localPath) {
      return {
        workspace,
        requiresMismatchConfirmation: workspace.state === 'mismatch',
        updated: { conversations: 0, projects: 0, artifacts: 0, automations: 0 },
        automationsRemainDisabled: true,
      }
    }

    const marker = unboundWorkspacePath(input.workspaceId)
    let updatedConversations = this.rebindV2Conversations(input.workspaceId)
    if (updatedConversations === null) {
      const conversations = new ConversationStore(this.layout.conversationsRoot)
      updatedConversations = 0
      for (const meta of conversations.list()) {
        const conversation = conversations.load(meta.id)
        if (!conversation || conversation.workspacePath !== marker) continue
        conversation.workspacePath = localPath
        conversations.save(conversation, { compact: true })
        updatedConversations += 1
      }
    }

    const projects = rewriteCollection(this.layout.projectsPath, 'projects', project => {
      if (project.path !== marker) return false
      project.path = localPath
      project.available = true
      return true
    })
    const artifacts = rewriteCollection(this.layout.artifactsPath, 'artifacts', artifact => {
      if (artifact.workspacePath !== marker) return false
      artifact.workspacePath = localPath
      artifact.available = typeof artifact.path === 'string' && existsSync(artifact.path)
      return true
    })
    const automations = rewriteCollection(this.layout.automationsPath, 'automations', automation => {
      const matches = automation.workspacePath === marker
      if (matches) automation.workspacePath = localPath
      const wasUnsafe = automation.enabled !== false
        || (automation.status !== 'paused' && automation.status !== 'archived')
        || automation.activeRunId !== undefined
        || automation.nextRunAt !== undefined
      automation.enabled = false
      automation.status = automation.status === 'archived' ? 'archived' : 'paused'
      delete automation.activeRunId
      delete automation.nextRunAt
      return matches || wasUnsafe
    })

    return {
      workspace: this.bindings.get(input.workspaceId) ?? workspace,
      requiresMismatchConfirmation: false,
      updated: { conversations: updatedConversations, projects, artifacts, automations },
      automationsRemainDisabled: true,
    }
  }
}
