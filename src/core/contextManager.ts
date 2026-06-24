import { existsSync, readFileSync } from 'node:fs'
import type { AgentAttachment, AgentTurn, TokenUsage } from '../shared/agentTypes'
import type { ContextSegment } from '../state/types'
import type { ContextPolicyProfile } from './contextPolicy'
import { effectiveInputWindow, resolveContextPolicyProfile } from './contextPolicy'
import { countMessagesTokens, countTextTokens, type TokenCountResult } from './tokenCounter'
import { compressToolResult } from './tokenCompressor'

// ==================== Structured Summary ====================

/**
 * Structured summary extracted from old conversation turns.
 * This replaces truncated content — the model gets meaningful context,
 * not misleading partial file contents.
 */
export interface StructuredSummary {
  /** Files that were accessed, with operation type */
  filesAccessed: Array<{ path: string; op: 'read' | 'write' | 'edit' | 'delete'; lines?: number }>
  /** User decisions from ask_user */
  decisions: Array<{ question: string; answer: string }>
  /** Task state snapshots */
  taskSnapshots: Array<{ taskId: string; title: string; status: string }>
  /** Checkpoints created */
  checkpoints: Array<{ id: string; label: string }>
  /** Errors encountered */
  errors: Array<{ tool: string; summary: string }>
  /** Brief outline of old conversation flow */
  conversationOutline: string[]
  /** The user's original goal */
  originalGoal: string
}

const MAX_SUMMARY_FILES = 20
const MAX_SUMMARY_DECISIONS = 10
const MAX_SUMMARY_TASKS = 20
const MAX_SUMMARY_CHECKPOINTS = 10
const MAX_SUMMARY_ERRORS = 10
const MAX_SUMMARY_OUTLINE = 12

/**
 * Extract structured summary from old turns.
 * Instead of truncating, we extract WHO, WHAT, WHY — not raw content.
 */
export function extractStructuredSummary(turns: AgentTurn[]): StructuredSummary {
  const summary: StructuredSummary = {
    filesAccessed: [],
    decisions: [],
    taskSnapshots: [],
    checkpoints: [],
    errors: [],
    conversationOutline: [],
    originalGoal: '',
  }

  const seenFiles = new Set<string>()

  for (const turn of turns) {
    // Extract original goal from first user message
    if (turn.role === 'user' && !summary.originalGoal) {
      summary.originalGoal = turn.content.slice(0, 200)
    }

    // Extract info from tool calls
    if (turn.toolCalls) {
      for (const tc of turn.toolCalls) {
        const args = tc.arguments

        // File operations
        const filePath = (args.path || args.file_path || args.filePath || '') as string
        if (filePath) {
          const key = `${tc.name}:${filePath}`
          if (!seenFiles.has(key)) {
            seenFiles.add(key)
            const op = mapToolToOperation(tc.name)
            if (op) {
              summary.filesAccessed.push({
                path: filePath,
                op,
                lines: (args.lines as number) || undefined,
              })
            }
          }
        }

        // Task operations
        if (tc.name === 'create_task' || tc.name === 'create_tasks' || tc.name === 'update_task') {
          if (tc.name === 'create_tasks' && Array.isArray(args.tasks)) {
            for (const item of args.tasks as Array<Record<string, unknown>>) {
              summary.taskSnapshots.push({
                taskId: '',
                title: String(item.title || item.description || ''),
                status: 'pending',
              })
            }
          } else {
            summary.taskSnapshots.push({
              taskId: (args.taskId || args.id || '') as string,
              title: (args.title || args.description || '') as string,
              status: (args.status || 'unknown') as string,
            })
          }
        }

        // Checkpoint operations
        if (tc.name === 'create_checkpoint') {
          summary.checkpoints.push({
            id: (args.id || '') as string,
            label: (args.message || '') as string,
          })
        }
      }
    }

    // Extract info from tool results
    if (turn.toolResults) {
      for (const tr of turn.toolResults) {
        if (tr.isError) {
          summary.errors.push({
            tool: tr.name,
            summary: tr.output.slice(0, 100),
          })
        }

        // Decisions from ask_user
        if (tr.name === 'ask_user') {
          summary.decisions.push({
            question: '(user was asked)',
            answer: tr.output.slice(0, 150),
          })
        }

        // Task results
        if (tr.name === 'create_task' || tr.name === 'update_task') {
          const parsed = tryParseJSON(tr.output)
          if (parsed) {
            summary.taskSnapshots.push({
              taskId: String(parsed.id || parsed.taskId || ''),
              title: String(parsed.title || parsed.description || ''),
              status: String(parsed.status || 'unknown'),
            })
          }
        }
        if (tr.name === 'create_tasks') {
          const parsed = tryParseJSON(tr.output)
          if (parsed && Array.isArray(parsed.created)) {
            for (const item of parsed.created as Array<Record<string, unknown>>) {
              summary.taskSnapshots.push({
                taskId: String(item.id || ''),
                title: String(item.title || ''),
                status: String(item.status || 'pending'),
              })
            }
          }
        }

        // Checkpoint results
        if (tr.name === 'create_checkpoint') {
          const parsed = tryParseJSON(tr.output)
          if (parsed?.checkpointId) {
            summary.checkpoints.push({
              id: String(parsed.checkpointId),
              label: String(parsed.message || parsed.label || ''),
            })
          }
        }
      }
    }

    // Build conversation outline from assistant messages
    if (turn.role === 'assistant' && turn.content) {
      // Strip thinking blocks
      const cleanContent = turn.content
        .replace(/<(?:think|thinking|reasoning|analysis|thought)(?:\s[^>]*)?>[\s\S]*?<\/(?:think|thinking|reasoning|analysis|thought)>/gi, '')
        .replace(/<(?:think|thinking|reasoning|analysis|thought)(?:\s[^>]*)?>[\s\S]*$/gi, '')
        .replace(/<\/(?:think|thinking|reasoning|analysis|thought)>/gi, '')
        .trim()
      if (cleanContent) {
        // Take first sentence or first 150 chars (was 80 — too short for
        // meaningful decision context; arxiv:2512.22087 recommends preserving
        // enough semantic content to reconstruct intent at milestone boundaries)
        const firstSentence = cleanContent.split(/[.\n]/)[0] || ''
        const concise = firstSentence.length > 150 ? `${firstSentence.slice(0, 150)}…` : firstSentence
        summary.conversationOutline.push(concise)
      }
    }
  }

  summary.filesAccessed = summary.filesAccessed.slice(0, MAX_SUMMARY_FILES)
  summary.decisions = summary.decisions.slice(0, MAX_SUMMARY_DECISIONS)
  summary.checkpoints = summary.checkpoints.slice(0, MAX_SUMMARY_CHECKPOINTS)
  summary.errors = summary.errors.slice(0, MAX_SUMMARY_ERRORS)
  summary.conversationOutline = summary.conversationOutline.slice(0, MAX_SUMMARY_OUTLINE)

  // Deduplicate task snapshots — keep last status for each taskId
  const taskMap = new Map<string, { taskId: string; title: string; status: string }>()
  for (const ts of summary.taskSnapshots) {
    if (ts.taskId) taskMap.set(ts.taskId, ts)
  }
  summary.taskSnapshots = Array.from(taskMap.values()).slice(0, MAX_SUMMARY_TASKS)

  return summary
}

function mapToolToOperation(toolName: string): 'read' | 'write' | 'edit' | 'delete' | null {
  switch (toolName) {
    case 'read_file':
    case 'read_file_full':
      return 'read'
    case 'list_directory': return 'read'
    case 'search_files': return 'read'
    case 'search_content': return 'read'
    case 'search_symbols': return 'read'
    case 'get_codemap': return 'read'
    case 'write_file':
    case 'replace_file':
      return 'write'
    case 'edit_file': return 'edit'
    case 'delete_file': return 'delete'
    default: return null
  }
}

function tryParseJSON(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

const VISION_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_DIRECT_IMAGE_BYTES = 5 * 1024 * 1024

function attachmentToDataUrl(attachment: AgentAttachment): string | null {
  if (!VISION_IMAGE_MIMES.has(attachment.mime)) return null
  if (!existsSync(attachment.path)) return null
  const bytes = readFileSync(attachment.path)
  if (bytes.length > MAX_DIRECT_IMAGE_BYTES) return null
  return `data:${attachment.mime};base64,${bytes.toString('base64')}`
}

function attachmentManifestText(attachments: AgentAttachment[]): string {
  return [
    '<attachments>',
    'Image attachments are saved locally and are also attached to this message when the provider supports vision input.',
    ...attachments.map((attachment, index) =>
      `<image name="[Image #${index + 1}]" path="${attachment.path}" mime="${attachment.mime}" filename="${attachment.filename}" size="${attachment.size}" />`
    ),
    '</attachments>',
  ].join('\n')
}

function buildUserContentWithAttachments(
  turn: AgentTurn,
  provider: 'openai' | 'anthropic',
): Array<Record<string, unknown>> | null {
  const attachments = turn.metadata?.attachments?.filter(attachment => attachment.type === 'image') ?? []
  if (attachments.length === 0) return null

  const content: Array<Record<string, unknown>> = []
  const text = [turn.content.trim(), attachmentManifestText(attachments)].filter(Boolean).join('\n\n')
  content.push({ type: 'text', text })

  for (const attachment of attachments) {
    const dataUrl = attachmentToDataUrl(attachment)
    if (!dataUrl) {
      content.push({
        type: 'text',
        text: `[Image attachment unavailable for direct vision input: ${attachment.path} (${attachment.mime})]`,
      })
      continue
    }
    const base64 = dataUrl.slice(dataUrl.indexOf(';base64,') + ';base64,'.length)
    if (provider === 'anthropic') {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.mime,
          data: base64,
        },
      })
    } else {
      content.push({
        type: 'image_url',
        image_url: { url: dataUrl },
      })
    }
  }

  return content
}

/**
 * Format a structured summary into a compact string for the context window.
 * This is what the model actually sees — clean, semantic, no misleading partial content.
 */
export function formatSummaryAsContext(summary: StructuredSummary): string {
  const parts: string[] = []

  parts.push('<context_summary>')
  parts.push('This is a structured summary of earlier conversation. Key information is preserved; raw file contents are omitted (re-read files if needed).')

  if (summary.originalGoal) {
    parts.push(`\n<goal>${summary.originalGoal}</goal>`)
  }

  if (summary.filesAccessed.length > 0) {
    parts.push('\n<files_accessed>')
    for (const f of summary.filesAccessed) {
      const lineInfo = f.lines ? ` (${f.lines} lines)` : ''
      parts.push(`- ${f.op}: ${f.path}${lineInfo}`)
    }
    parts.push('</files_accessed>')
  }

  if (summary.decisions.length > 0) {
    parts.push('\n<decisions>')
    for (const d of summary.decisions) {
      parts.push(`- Q: ${d.question} → A: ${d.answer}`)
    }
    parts.push('</decisions>')
  }

  if (summary.taskSnapshots.length > 0) {
    parts.push('\n<task_state>')
    for (const t of summary.taskSnapshots) {
      parts.push(`- [${t.status}] ${t.taskId}: ${t.title}`)
    }
    parts.push('</task_state>')
  }

  if (summary.checkpoints.length > 0) {
    parts.push('\n<checkpoints>')
    for (const c of summary.checkpoints) {
      parts.push(`- ${c.id}: ${c.label}`)
    }
    parts.push('</checkpoints>')
  }

  if (summary.errors.length > 0) {
    parts.push('\n<errors_encountered>')
    for (const e of summary.errors) {
      parts.push(`- ${e.tool}: ${e.summary}`)
    }
    parts.push('</errors_encountered>')
  }

  if (summary.conversationOutline.length > 0) {
    parts.push('\n<conversation_outline>')
    for (const [idx, line] of summary.conversationOutline.entries()) {
      parts.push(`${idx + 1}. ${line}`)
    }
    parts.push('</conversation_outline>')
  }

  parts.push('</context_summary>')

  return parts.join('\n')
}

// ==================== Context Manager ====================

/**
 * Deduplicate read_file results for the same file path.
 *
 * When an agent reads the same file multiple times (read → edit → re-read),
 * the context fills with stale copies of the same content. Only the LATEST
 * read_file result for each path is kept intact; earlier reads are replaced
 * with a short placeholder.
 *
 * Strategy (Cline v3.25, April 2025):
 *   "Cline ends up loading the same file many times... This not only wastes
 *    precious space in the context window, but can lead to certain LLM models
 *    having a harder time identifying correct chunks of the file for editing."
 *
 * This function returns a new array of turns — the original session.turns is
 * never mutated. Only tool_result turns whose toolResults contain read_file
 * outputs are affected.
 */
function isReadFileTool(name: string): boolean {
  return name === 'read_file' || name === 'read_file_full'
}

function deduplicateReadFileResults(turns: AgentTurn[]): AgentTurn[] {
  // First pass: find the LAST occurrence index for each file path in read_file results.
  // We track by (toolCallId → path) so we can identify which result to keep.
  const lastReadIndexByPath = new Map<string, number>()

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    if (turn.role !== 'tool_result' || !turn.toolResults) continue
    for (const tr of turn.toolResults) {
      if (!isReadFileTool(tr.name)) continue
      // Extract path from the tool call id lookup — we need the corresponding
      // tool_call to get the path argument. Walk backwards to find it.
      // Simpler: extract path from the output itself (first line often has it)
      // or from the toolCallId → match with assistant turn's toolCalls.
      // We use a heuristic: store by toolCallId, then resolve paths below.
      lastReadIndexByPath.set(tr.toolCallId, i)
    }
  }

  // Build a map from toolCallId → file path by scanning assistant turns
  const pathByToolCallId = new Map<string, string>()
  for (const turn of turns) {
    if (turn.role !== 'assistant' || !turn.toolCalls) continue
    for (const tc of turn.toolCalls) {
      if (!isReadFileTool(tc.name)) continue
      const path = (tc.arguments.path as string) || ''
      if (path) pathByToolCallId.set(tc.id, path)
    }
  }

  // Build a map: path → last turn index that has a read_file result for it
  const lastTurnIdxByPath = new Map<string, number>()
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    if (turn.role !== 'tool_result' || !turn.toolResults) continue
    for (const tr of turn.toolResults) {
      if (!isReadFileTool(tr.name)) continue
      const path = pathByToolCallId.get(tr.toolCallId)
      if (path) lastTurnIdxByPath.set(path, i)
    }
  }

  // Second pass: build the deduplicated turns array
  return turns.map((turn, i) => {
    if (turn.role !== 'tool_result' || !turn.toolResults) return turn

    let modified = false
    const newToolResults = turn.toolResults.map(tr => {
      if (!isReadFileTool(tr.name)) return tr
      const path = pathByToolCallId.get(tr.toolCallId)
      if (!path) return tr
      const lastIdx = lastTurnIdxByPath.get(path)
      // If this is NOT the last read of this file, replace with a keyword
      // bookmark (arxiv:2604.12376 — cooperative paging). The bookmark
      // preserves the file path and a short keyword hint so the model can
      // decide whether to re-fetch without wasting tokens on stale content.
      if (lastIdx !== undefined && lastIdx !== i) {
        modified = true
        // Extract a minimal keyword hint from the stale output: grab the
        // first non-empty line that looks like a declaration or heading.
        const hint = extractKeywordHint(tr.output)
        const hintSuffix = hint ? `, keywords: ${hint}` : ''
        return {
          ...tr,
          output: `[evicted: ${path}${hintSuffix} — superseded by a later read; use read_file or read_file_full to retrieve]`,
        }
      }
      return tr
    })

    return modified ? { ...turn, toolResults: newToolResults } : turn
  })
}

/**
 * Extract a short keyword hint from a stale tool output.
 * Used to build cooperative-paging bookmarks (arxiv:2604.12376).
 * Returns up to ~40 chars of the most signal-rich content found.
 */
function extractKeywordHint(output: string): string {
  if (!output) return ''
  const lines = output.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Prefer lines with declarations, exports, class/function names
    if (/\b(export|class|function|interface|type|const|enum)\b/.test(trimmed)) {
      return trimmed.slice(0, 40).replace(/\s+/g, ' ')
    }
  }
  // Fallback: first non-empty line
  const first = lines.find(l => l.trim())
  return first ? first.trim().slice(0, 40) : ''
}

function getInputBudget(contextWindow: number, maxOutputTokens: number, policyProfile: ContextPolicyProfile): number {
  const usableWindow = effectiveInputWindow(contextWindow, maxOutputTokens)
  return Math.max(1_024, Math.floor(usableWindow * policyProfile.targetRatio))
}

function tokenCountValue(result: TokenCountResult): number {
  return result.source === 'unavailable' ? Number.POSITIVE_INFINITY : result.tokens
}

function tokenCountOptions(provider: 'openai' | 'anthropic', model?: string): { provider: string; model?: string } {
  return { provider, model }
}

export class ContextManager {
  private lastProviderUsage: TokenUsage | null = null

  buildSegmentContext(
    contextSegments?: ContextSegment[],
    maxTokens = Number.POSITIVE_INFINITY,
    counterOptions: { provider: string; model?: string } = { provider: 'custom' },
  ): string {
    const validSegments = (contextSegments ?? [])
      .filter(segment => segment.isValid && segment.summary.trim())
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))

    if (validSegments.length === 0) return ''

    const parts: string[] = [
      '<compressed_conversation_history>',
      'Earlier conversation turns were compacted. Treat these summaries as continuity context; re-read files when exact contents are needed.',
    ]

    let usedTokens = tokenCountValue(countTextTokens(parts.join('\n'), counterOptions))
    for (const segment of validSegments) {
      const segmentParts = [
        `<segment start="${segment.startMessageId}" end="${segment.endMessageId}" source="${segment.isModelGenerated ? 'model' : 'structured'}">`,
        segment.summary.trim(),
        '</segment>',
      ]
      const segmentTokens = tokenCountValue(countTextTokens(segmentParts.join('\n'), counterOptions))
      if (usedTokens + segmentTokens > maxTokens && parts.length > 2) continue
      parts.push(...segmentParts)
      usedTokens += segmentTokens
    }

    parts.push('</compressed_conversation_history>')
    return parts.join('\n')
  }

  /**
   * Build the messages array for the API call, respecting the model's context window.
   *
   * Strategy (layered memory):
   * 1. Short-term: Recent N turns kept fully intact
   * 2. Mid-term: Valid context segments are injected as continuation summaries
   * 3. Fallback: If no segment covers old turns, use structured extraction
   * 4. The first user message (original goal) is always preserved
   *
   * Key principle: truncation is NOT compression. A truncated file content is worse
   * than no file content — it misleads the model. Instead, we inject model-generated
   * continuation summaries or structured WHO/WHAT/WHY extractions.
   */
  buildMessages(
    turns: AgentTurn[],
    systemPrompt: string,
    contextWindow: number,
    provider: 'openai' | 'anthropic',
    maxOutputTokens: number,
    contextSegments?: ContextSegment[],
    policyProfile: ContextPolicyProfile = resolveContextPolicyProfile(),
    model?: string,
  ): Array<Record<string, unknown>> {
    const counterOptions = tokenCountOptions(provider, model)
    const liveTurnIds = new Set(turns.map(turn => turn.id))
    const injectableSegments = (contextSegments ?? []).filter(segment =>
      !(liveTurnIds.has(segment.startMessageId) && liveTurnIds.has(segment.endMessageId))
    )
    const inputBudget = getInputBudget(contextWindow, maxOutputTokens, policyProfile)
    const segmentContext = this.buildSegmentContext(injectableSegments, policyProfile.maxSegmentTokens, counterOptions)

    // Pre-pass: deduplicate read_file results for the same path.
    // When the agent reads the same file multiple times (e.g. read → edit →
    // re-read to verify), only the LATEST read result for each path is kept
    // intact; earlier reads are replaced with a short placeholder.
    // This mirrors Cline's "remove outdated file reads" strategy and can
    // eliminate hundreds of kilobytes of redundant content per session.
    //
    // We operate on a shallow copy of the turns array so the original
    // session.turns is never mutated — the deduplication is view-only.
    const deduplicatedTurns = deduplicateReadFileResults(turns)

    // Alias for the rest of the function — all logic below uses deduplicatedTurns
    const turns_ = deduplicatedTurns

    // If no compression needed, return all turns as-is — but still apply
    // the rolling-window observation masking to prevent raw tool outputs
    // from accumulating unboundedly.
    //
    // Research basis (JetBrains / NeurIPS 2025, arxiv:2508.21433):
    //   Keeping the last N=10 tool_result turns intact and replacing older
    //   ones with placeholders halves context cost while matching or slightly
    //   exceeding LLM-summarisation solve rates on SWE-bench Verified.
    //   N=10 was the empirically optimal window size across all tested models.
    //
    // The placeholder text mirrors SWE-agent's convention so the model
    // understands it can re-fetch the content if needed.
    const ROLLING_WINDOW_N = policyProfile.recentToolResultTurns
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: systemPrompt },
    ]
    if (segmentContext) {
      messages.push(this.contextMessage(segmentContext, provider))
    }
    const nonSystemTurns = turns_.filter(t => t.role !== 'system')
    const toolResultTurns = nonSystemTurns.filter(t => t.role === 'tool_result')
    // Keep the most recent ROLLING_WINDOW_N tool_result turns intact;
    // compress everything older.
    const toolResultCutoff = Math.max(0, toolResultTurns.length - ROLLING_WINDOW_N)
    let toolResultIdx = 0
    for (const turn of nonSystemTurns) {
      if (turn.role === 'tool_result' && Array.isArray(turn.toolResults) && turn.toolResults.length > 0) {
        if (toolResultIdx < toolResultCutoff) {
          const compressedResults = turn.toolResults.map(tr => {
            const report = compressToolResult(tr.name, tr.output)
            return report.method === 'skipped' ? tr : { ...tr, output: report.compressed }
          })
          messages.push(...this.turnToMessages({ ...turn, toolResults: compressedResults }, provider))
        } else {
          messages.push(...this.turnToMessages(turn, provider))
        }
        toolResultIdx++
      } else {
        messages.push(...this.turnToMessages(turn, provider))
      }
    }
    if (tokenCountValue(countMessagesTokens(messages, counterOptions)) <= inputBudget) {
      return messages
    }

    return this.buildBudgetedMessages({
      turns: turns_,
      systemPrompt,
      provider,
      contextSegments: injectableSegments,
      inputBudget,
      policyProfile,
      model,
    })
  }

  private buildBudgetedMessages(params: {
    turns: AgentTurn[]
    systemPrompt: string
    provider: 'openai' | 'anthropic'
    contextSegments: ContextSegment[]
    inputBudget: number
    policyProfile: ContextPolicyProfile
    model?: string
  }): Array<Record<string, unknown>> {
    const { turns, systemPrompt, provider, contextSegments, inputBudget, policyProfile, model } = params
    const counterOptions = tokenCountOptions(provider, model)
    const systemMessage = { role: 'system', content: systemPrompt }
    const messages: Array<Record<string, unknown>> = [systemMessage]
    const baseTokens = tokenCountValue(countMessagesTokens(messages, counterOptions))
    const hardFloor = Math.max(1024, Math.floor(inputBudget * 0.18))
    let remaining = Math.max(hardFloor, inputBudget - baseTokens)

    const nonSystemTurns = turns.filter(turn => turn.role !== 'system')
    const groups = this.groupTurnsForBudget(nonSystemTurns, provider, policyProfile.recentToolResultTurns, model)
    const selectedGroups: Array<{ firstIndex: number; turns: AgentTurn[]; messages: Array<Record<string, unknown>>; tokens: number }> = []
    const desiredTailGroups = Math.min(groups.length, Math.max(1, Math.ceil(policyProfile.minTailTurns / 2)))
    const protectedTailGroups = Math.min(groups.length, 2)

    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index]
      const mustKeep = selectedGroups.length < protectedTailGroups
      const shouldKeepTail = selectedGroups.length < desiredTailGroups && group.tokens <= Math.floor(inputBudget * 0.35)
      if (mustKeep || shouldKeepTail) {
        selectedGroups.push(group)
        remaining -= Math.min(group.tokens, remaining)
      } else {
        break
      }
    }
    selectedGroups.reverse()

    const firstSelectedIndex = selectedGroups[0]?.firstIndex ?? nonSystemTurns.length
    const omittedTurns = nonSystemTurns.slice(0, firstSelectedIndex)
    const summaryMessages: Array<Record<string, unknown>> = []
    const segmentBudget = Math.max(0, Math.min(policyProfile.maxSegmentTokens, Math.floor(inputBudget * 0.25)))
    const segmentContext = this.buildSegmentContext(contextSegments, segmentBudget, counterOptions)
    if (segmentContext) {
      summaryMessages.push(this.contextMessage(segmentContext, provider))
    }

    if (omittedTurns.length > 0) {
      const structured = formatSummaryAsContext(extractStructuredSummary(omittedTurns))
      summaryMessages.push(this.contextMessage([
        '<windowed_history_summary>',
        'Older live turns were omitted from this request to fit the active model context window. Re-read files or inspect history when exact evidence is needed.',
        structured,
        '</windowed_history_summary>',
      ].join('\n'), provider))
    }

    for (const summaryMessage of summaryMessages) {
      const tokens = tokenCountValue(countMessagesTokens([summaryMessage], counterOptions))
      if (tokens <= remaining) {
        messages.push(summaryMessage)
        remaining -= tokens
      }
    }

    for (const group of selectedGroups) {
      messages.push(...group.messages)
    }

    const beforeTrimCount = messages.length
    while (tokenCountValue(countMessagesTokens(messages, counterOptions)) > inputBudget && messages.length > 2) {
      const removableIndex = messages.findIndex((message, index) =>
        index > 0 && typeof message.content === 'string' && String(message.content).includes('<compressed_conversation_history>')
      )
      if (removableIndex > 0) {
        messages.splice(removableIndex, 1)
        continue
      }
      const firstSummary = messages.findIndex((message, index) =>
        index > 0 && typeof message.content === 'string' && String(message.content).includes('<windowed_history_summary>')
      )
      if (firstSummary > 0) messages.splice(firstSummary, 1)
      else break
    }

    void beforeTrimCount
    return tokenCountValue(countMessagesTokens(messages, counterOptions)) > inputBudget
      ? this.shrinkOversizedToolMessages(messages, inputBudget, counterOptions)
      : messages
  }

  private groupTurnsForBudget(
    turns: AgentTurn[],
    provider: 'openai' | 'anthropic',
    recentToolResultTurns: number,
    model?: string,
  ): Array<{ firstIndex: number; turns: AgentTurn[]; messages: Array<Record<string, unknown>>; tokens: number }> {
    const counterOptions = tokenCountOptions(provider, model)
    const compressedTurns = this.compressOlderToolResults(turns, recentToolResultTurns)
    const groups: Array<{ firstIndex: number; turns: AgentTurn[]; messages: Array<Record<string, unknown>>; tokens: number }> = []

    for (let index = 0; index < compressedTurns.length; index += 1) {
      const turn = compressedTurns[index]
      const groupTurns = [turn]
      if (turn.role === 'assistant' && turn.toolCalls && compressedTurns[index + 1]?.role === 'tool_result') {
        groupTurns.push(compressedTurns[index + 1])
        index += 1
      }
      const groupMessages = groupTurns.flatMap(groupTurn => this.turnToMessages(groupTurn, provider))
      groups.push({
        firstIndex: index - groupTurns.length + 1,
        turns: groupTurns,
        messages: groupMessages,
        tokens: tokenCountValue(countMessagesTokens(groupMessages, counterOptions)),
      })
    }

    return groups
  }

  private compressOlderToolResults(turns: AgentTurn[], recentToolResultTurns: number): AgentTurn[] {
    const toolResultTurns = turns.filter(turn => turn.role === 'tool_result')
    const toolResultCutoff = Math.max(0, toolResultTurns.length - recentToolResultTurns)
    let toolResultIdx = 0
    return turns.map(turn => {
      if (turn.role !== 'tool_result' || !Array.isArray(turn.toolResults) || turn.toolResults.length === 0) {
        return turn
      }
      if (toolResultIdx >= toolResultCutoff) {
        toolResultIdx += 1
        return turn
      }
      toolResultIdx += 1
      const compressedResults = turn.toolResults.map(tr => {
        const report = compressToolResult(tr.name, tr.output)
        return report.method === 'skipped' ? tr : { ...tr, output: report.compressed }
      })
      return { ...turn, toolResults: compressedResults }
    })
  }

  private shrinkOversizedToolMessages(
    messages: Array<Record<string, unknown>>,
    inputBudget: number,
    counterOptions: { provider: string; model?: string },
  ): Array<Record<string, unknown>> {
    const next = messages.map(message => ({ ...message }))
    for (let index = next.length - 1; index >= 0 && tokenCountValue(countMessagesTokens(next, counterOptions)) > inputBudget; index -= 1) {
      const message = next[index]
      if (message.role !== 'tool' || typeof message.content !== 'string') continue
      const maxChars = Math.max(1_200, Math.floor(inputBudget * 2))
      if (message.content.length <= maxChars) continue
      message.content = `${message.content.slice(0, maxChars)}\n<truncated_for_active_context_window />`
    }
    return next
  }

  private contextMessage(text: string, provider: 'openai' | 'anthropic'): Record<string, unknown> {
    void provider
    return {
      role: 'user',
      content: text,
    }
  }

  /**
   * Update token tracking with actual values from API response.
   *
   * inputTokens here is the provider-reported prompt_tokens for the turn we
   * just finished. It already includes the full conversation history that
   * was shipped, so we OVERWRITE rather than accumulate — this becomes the
   * ground truth for the next compression decision.
   *
   * outputTokens IS additive across turns (each turn produces new bytes the
   * model didn't produce before), so we accumulate it for cost/session
   * reporting.
   */
  updateTokenCounting(inputTokens: number, outputTokens: number): void {
    this.lastProviderUsage = {
      input: inputTokens,
      output: outputTokens,
      total: inputTokens + outputTokens,
      source: inputTokens > 0 || outputTokens > 0 ? 'provider' : 'unknown',
    }
  }

  getLastProviderUsage(): TokenUsage {
    return this.lastProviderUsage ?? { source: 'unknown' }
  }

  /**
   * Reset state for a new session.
   */
  reset(): void {
    this.lastProviderUsage = null
  }

  /**
   * Restore a baseline input token count after rollback.
   * Used when restoreFromMessages rewinds the conversation — we re-estimate
   * the ground-truth occupancy so the context bar reflects the rewound state.
   */
  restoreBaseline(_turns: AgentTurn[], _systemPrompt: string): void {
    this.lastProviderUsage = null
  }

  private turnToMessages(
    turn: AgentTurn,
    provider: 'openai' | 'anthropic',
  ): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = []

    if (turn.role === 'tool_result' && turn.toolResults) {
      for (const tr of turn.toolResults) {
        if (provider === 'anthropic') {
          messages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: tr.toolCallId,
              content: tr.output,
            }],
          })
        } else {
          messages.push({
            role: 'tool',
            tool_call_id: tr.toolCallId,
            content: tr.output,
          })
        }
      }
      return messages
    }

    if (turn.role === 'user') {
      const attachmentContent = buildUserContentWithAttachments(turn, provider)
      if (attachmentContent) {
        messages.push({
          role: 'user',
          content: attachmentContent,
        })
        return messages
      }
    }

    if (turn.role === 'assistant' && turn.toolCalls && turn.toolCalls.length > 0) {
      if (provider === 'anthropic') {
        const content: Array<Record<string, unknown>> = []
        // Replay raw reasoning blocks (with their original signature hashes)
        // before any text/tool_use blocks. Anthropic requires the full
        // unmodified thinking sequence to be passed back across tool-use turns
        // to maintain reasoning continuity. Skip when the assistant turn was
        // produced without provider-native thinking (no rawReasoningPayload).
        const rawReasoning = turn.metadata?.rawReasoningPayload
        if (rawReasoning?.provider === 'anthropic' && Array.isArray(rawReasoning.blocks)) {
          for (const block of rawReasoning.blocks) {
            if (block.type === 'thinking' && (block.thinking || block.signature)) {
              content.push({
                type: 'thinking',
                thinking: block.thinking ?? '',
                ...(block.signature ? { signature: block.signature } : {}),
              })
            } else if (block.type === 'redacted_thinking' && block.data) {
              content.push({ type: 'redacted_thinking', data: block.data })
            }
          }
        }
        if (turn.content) {
          content.push({ type: 'text', text: turn.content })
        }
        for (const tc of turn.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          })
        }
        messages.push({ role: 'assistant', content })
      } else {
        const openaiToolCalls = turn.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }))

        const openaiMsg: Record<string, unknown> = {
          role: 'assistant',
          content: turn.content || '',
          tool_calls: openaiToolCalls,
        }
        // Echo back reasoning_content for OpenAI-compatible providers that
        // require it (e.g. mimo, DeepSeek-R1). Without this the API returns
        // 400 "The reasoning_content in the thinking mode must be passed back".
        const openaiReasoning = turn.metadata?.rawReasoningPayload
        if (openaiReasoning?.provider === 'openai-compatible' && openaiReasoning.reasoningContent) {
          openaiMsg.reasoning_content = openaiReasoning.reasoningContent
        }
        messages.push(openaiMsg)
      }
      return messages
    }

    // For Anthropic assistant turns without tool calls, we still need to replay
    // any raw reasoning blocks (thinking/redacted_thinking) that were produced
    // during the response. Anthropic requires these to be passed back in every
    // subsequent turn when thinking mode was active — not just tool-use turns.
    if (provider === 'anthropic' && turn.role === 'assistant') {
      const rawReasoning = turn.metadata?.rawReasoningPayload
      if (rawReasoning?.provider === 'anthropic' && Array.isArray(rawReasoning.blocks) && rawReasoning.blocks.length > 0) {
        const content: Array<Record<string, unknown>> = []
        for (const block of rawReasoning.blocks) {
          if (block.type === 'thinking' && (block.thinking || block.signature)) {
            content.push({
              type: 'thinking',
              thinking: block.thinking ?? '',
              ...(block.signature ? { signature: block.signature } : {}),
            })
          } else if (block.type === 'redacted_thinking' && block.data) {
            content.push({ type: 'redacted_thinking', data: block.data })
          }
        }
        if (turn.content) {
          content.push({ type: 'text', text: turn.content })
        }
        messages.push({ role: 'assistant', content })
        return messages
      }
    }

    // For OpenAI-compatible assistant turns without tool calls, echo back
    // reasoning_content if present. This covers the common case where the
    // model returns a plain text reply (no tool use) but still produced
    // reasoning that must be passed back in the next request.
    if (provider === 'openai' && turn.role === 'assistant') {
      const openaiReasoning = turn.metadata?.rawReasoningPayload
      if (openaiReasoning?.provider === 'openai-compatible' && openaiReasoning.reasoningContent) {
        messages.push({
          role: 'assistant',
          content: turn.content,
          reasoning_content: openaiReasoning.reasoningContent,
        })
        return messages
      }
    }

    messages.push({
      role: turn.role,
      content: turn.content,
    })

    return messages
  }
}
