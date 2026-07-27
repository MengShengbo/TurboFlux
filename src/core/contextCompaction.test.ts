import { describe, expect, it } from 'vitest'
import type { AgentTurn } from '../shared/agentTypes'
import {
  buildContinuationEvidence,
  buildContinuationSummaryPrompt,
  extractContinuationText,
  validateContinuationSummary,
} from './contextCompaction'

const turns: AgentTurn[] = [
  {
    id: 'a1',
    role: 'assistant',
    content: 'I inspected the workspace.',
    timestamp: 1,
    toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'src/app.ts', offset: 40 } }],
  },
  {
    id: 't1',
    role: 'tool_result',
    content: '',
    timestamp: 2,
    toolResults: [{ toolCallId: 'call-1', name: 'read_file', output: 'export const answer = 42', isError: false }],
  },
]

describe('context compaction compiler', () => {
  it('includes complete tool arguments and results in continuation evidence', () => {
    const evidence = buildContinuationEvidence(turns, [], {
      workspacePath: 'C:/repo',
      workspaceMemory: 'Use the existing public API.',
      taskTree: [{ id: 'task-1', status: 'in_progress' }],
    })

    expect(evidence).toContain('src/app.ts')
    expect(evidence).toContain('export const answer = 42')
    expect(evidence).toContain('Use the existing public API.')
    expect(evidence).toContain('task-1')
  })

  it('requires every continuation section before accepting a summary', () => {
    const prompt = buildContinuationSummaryPrompt('evidence')
    expect(prompt).toContain('<conversation_goal>')
    expect(prompt).toContain('untrusted historical data')

    const complete = `<continuation_summary>${[
      'conversation_goal',
      'project_state',
      'current_task',
      'recent_dialogue',
      'files_touched',
      'important_decisions',
      'open_questions',
      'next_step_hint',
    ].map(section => `<${section}>ok</${section}>`).join('')}</continuation_summary>`

    expect(validateContinuationSummary(complete).valid).toBe(true)
    expect(validateContinuationSummary('<continuation_summary><current_task>only</current_task></continuation_summary>').valid).toBe(false)
  })

  it('extracts text from raw JSON responses for all supported protocols', () => {
    expect(extractContinuationText('openai_chat', JSON.stringify({ choices: [{ message: { content: 'chat summary' } }] }))).toBe('chat summary')
    expect(extractContinuationText('openai_responses', JSON.stringify({ output_text: 'responses summary' }))).toBe('responses summary')
    expect(extractContinuationText('anthropic_messages', JSON.stringify({ content: [{ type: 'text', text: 'anthropic summary' }] }))).toBe('anthropic summary')
  })
})
