import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { ConversationMeta, PersistedConversation, ConversationIndex } from './types'

const CONVERSATIONS_DIR = join(homedir(), '.turboflux', 'conversations')

function ensureDir(): void {
  if (!existsSync(CONVERSATIONS_DIR)) {
    mkdirSync(CONVERSATIONS_DIR, { recursive: true })
  }
}

export function saveConversation(conv: PersistedConversation): void {
  ensureDir()
  const filePath = join(CONVERSATIONS_DIR, `${conv.id}.json`)
  writeFileSync(filePath, JSON.stringify(conv, null, 2), 'utf-8')
}

export function loadConversation(id: string): PersistedConversation | null {
  const filePath = join(CONVERSATIONS_DIR, `${id}.json`)
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

export function deleteConversation(id: string): boolean {
  const filePath = join(CONVERSATIONS_DIR, `${id}.json`)
  if (!existsSync(filePath)) return false
  unlinkSync(filePath)
  return true
}

export function listConversations(): ConversationMeta[] {
  ensureDir()
  const files = readdirSync(CONVERSATIONS_DIR).filter(f => f.endsWith('.json'))
  const metas: ConversationMeta[] = []

  for (const file of files) {
    try {
      const raw = readFileSync(join(CONVERSATIONS_DIR, file), 'utf-8')
      const conv: PersistedConversation = JSON.parse(raw)
      metas.push({
        id: conv.id,
        title: conv.title,
        workspacePath: conv.workspacePath,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        mode: conv.mode,
        model: conv.model,
        provider: conv.provider,
        turnCount: conv.turns.length,
      })
    } catch {
      // skip corrupted files
    }
  }

  return metas.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getConversationsDir(): string {
  return CONVERSATIONS_DIR
}
