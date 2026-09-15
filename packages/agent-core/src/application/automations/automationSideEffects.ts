import { createHash } from 'node:crypto'

export type AutomationToolSideEffectClass =
  | 'read_only'
  | 'idempotent_write'
  | 'reversible_write'
  | 'non_idempotent_write'
  | 'unknown_external_effect'

export interface AutomationToolEffectDeclaration {
  classification: AutomationToolSideEffectClass
  idempotencyKey?: string
  recoveryHint?: string
}

const readOnlyTools = new Set([
  'read_file',
  'read_file_full',
  'list_directory',
  'search_files',
  'search_content',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'list_terminals',
  'read_terminal',
  'list_tasks',
  'list_agents',
  'read_agent',
  'list_memories',
  'browser__observe',
  'browser__visual_observe',
  'browser__screenshot',
  'computer__observe',
  'web_search',
  'web_fetch',
])

const idempotentWriteTools = new Set([
  'write_file',
  'replace_file',
  'edit_file',
  'multi_edit',
  'delete_file',
  'apply_patch',
  'git_stage',
  'git_restore',
  'git_switch_branch',
  'git_create_branch',
])

const reversibleWriteTools = new Set([
  'git_stash',
  'git_revert',
])

const nonIdempotentWriteTools = new Set([
  'git_commit',
  'git_push',
  'browser__click',
  'browser__open',
  'browser__navigate',
  'browser__type_text',
  'browser__upload_file',
  'computer__click',
  'computer__double_click',
  'computer__drag',
  'computer__type_text',
  'computer__press',
])

function normalizedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(normalizedJson).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${normalizedJson(record[key])}`).join(',')}}`
}

function idempotencyKey(toolName: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(`${toolName}\0${normalizedJson(args)}`).digest('hex')
}

export function classifyAutomationToolEffect(
  toolName: string,
  args: Record<string, unknown>,
  hints: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } = {},
): AutomationToolEffectDeclaration {
  if (hints.readOnlyHint === true || readOnlyTools.has(toolName) || /(?:^|__)(?:read|list|search|observe|get|status|diff|show|log)$/.test(toolName)) {
    return { classification: 'read_only' }
  }
  if (hints.idempotentHint === true || idempotentWriteTools.has(toolName)) {
    return { classification: 'idempotent_write', idempotencyKey: idempotencyKey(toolName, args) }
  }
  if (reversibleWriteTools.has(toolName)) {
    return {
      classification: 'reversible_write',
      recoveryHint: 'Review the recorded tool output and apply the tool-specific rollback before retrying.',
    }
  }
  if (nonIdempotentWriteTools.has(toolName)) return { classification: 'non_idempotent_write' }
  return { classification: 'unknown_external_effect' }
}

export function automationToolEffectNeedsReview(classification: AutomationToolSideEffectClass): boolean {
  return classification === 'reversible_write'
    || classification === 'non_idempotent_write'
    || classification === 'unknown_external_effect'
}

export function summarizeAutomationToolTarget(args: Record<string, unknown>): string | undefined {
  const value = ['path', 'filePath', 'directory', 'cwd', 'url', 'domain', 'command']
    .map(key => args[key])
    .find(candidate => typeof candidate === 'string' && candidate.trim().length > 0)
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().slice(0, 500)
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 500)
    } catch {
      return '[invalid URL]'
    }
  }
  return trimmed
}
