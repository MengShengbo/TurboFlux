import { describe, expect, it } from 'vitest'
import type { AgentTurn } from '../shared/agentTypes'
import {
  buildContextHandoff,
  buildContinuationEvidence,
  buildContinuationSummaryPrompt,
  buildContinuationSummaryAnchors,
  buildDeterministicContinuationSummary,
  collectContinuationHandoffFacts,
  continuationSummaryTokenBudget,
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
    expect(validateContinuationSummary(complete, ['missing-anchor']).valid).toBe(false)
    expect(validateContinuationSummary('<continuation_summary><current_task>only</current_task></continuation_summary>').valid).toBe(false)
  })

  it('builds a deterministic handoff that validates semantic anchors', () => {
    const oldTurns: AgentTurn[] = [
      { id: 'u-old', role: 'user', content: 'fix context compression and preserve progress', timestamp: 1 },
      {
        id: 'a-edit',
        role: 'assistant',
        content: 'Patched context handling.',
        timestamp: 2,
        toolCalls: [{ id: 'edit-1', name: 'apply_patch', arguments: { path: 'src/core/contextCompaction.ts' } }],
      },
      {
        id: 'tr-edit',
        role: 'tool_result',
        content: '',
        timestamp: 3,
        toolResults: [{
          toolCallId: 'edit-1',
          name: 'apply_patch',
          output: 'ok',
          isError: false,
          changeSummary: { path: 'src/core/contextCompaction.ts', operation: 'edit' },
        }],
      },
    ]
    const recentTurns: AgentTurn[] = [
      { id: 'u-new', role: 'user', content: '继续做语义覆盖校验', timestamp: 4 },
    ]
    const workspace = { workspacePath: 'C:/repo', gitStatus: ' M src/core/contextCompaction.ts' }
    const facts = collectContinuationHandoffFacts(oldTurns, recentTurns, workspace)
    const summary = buildDeterministicContinuationSummary(facts)
    const anchors = buildContinuationSummaryAnchors(facts)

    expect(anchors).toContain('u-new')
    expect(anchors).toContain('src/core/contextCompaction.ts')
    expect(validateContinuationSummary(summary, anchors).valid).toBe(true)

    const handoff = buildContextHandoff({
      oldTurns,
      recentTurns,
      workspace,
      modelSummary: summary,
      startMessageId: 'u-old',
      endMessageId: 'tr-edit',
      source: 'manual',
      summarySource: 'deterministic',
      facts,
    })
    expect(handoff.document).toContain('TurboFlux Development Handoff')
    expect(handoff.document).toContain('src/core/contextCompaction.ts')
    expect(handoff.compactDocument.length).toBeLessThanOrEqual(20_000)
  })

  it('carries prior handoff facts forward across repeated compactions', () => {
    const firstTurns: AgentTurn[] = [
      { id: 'u1', role: 'user', content: 'initial task', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '', timestamp: 2, toolCalls: [{ id: 'write-1', name: 'write_file', arguments: { path: 'src/first.ts' } }] },
      { id: 't1', role: 'tool_result', content: '', timestamp: 3, toolResults: [{ toolCallId: 'write-1', name: 'write_file', output: 'done', isError: false }] },
    ]
    const workspace = { workspacePath: 'C:/repo' }
    const firstFacts = collectContinuationHandoffFacts(firstTurns, [], workspace)
    const first = buildContextHandoff({
      oldTurns: firstTurns,
      recentTurns: [],
      workspace,
      modelSummary: buildDeterministicContinuationSummary(firstFacts),
      startMessageId: 'u1',
      endMessageId: 't1',
      source: 'compact',
      summarySource: 'deterministic',
      facts: firstFacts,
    })

    const secondTurns: AgentTurn[] = [
      { id: 'u2', role: 'user', content: 'now fix tests', timestamp: 4 },
      { id: 'a2', role: 'assistant', content: '', timestamp: 5, toolCalls: [{ id: 'cmd-1', name: 'exec_command', arguments: { command: 'npm test' } }] },
      { id: 't2', role: 'tool_result', content: '', timestamp: 6, toolResults: [{ toolCallId: 'cmd-1', name: 'exec_command', output: 'passed', isError: false }] },
    ]
    const secondFacts = collectContinuationHandoffFacts(secondTurns, [], workspace, first.facts)
    const second = buildContextHandoff({
      oldTurns: secondTurns,
      recentTurns: [],
      workspace,
      previous: first,
      modelSummary: buildDeterministicContinuationSummary(secondFacts, first.modelSummary),
      startMessageId: 'u2',
      endMessageId: 't2',
      source: 'compact',
      summarySource: 'deterministic',
      facts: secondFacts,
    })

    expect(second.revision).toBe(2)
    expect(second.document).toContain('src/first.ts')
    expect(second.document).toContain('now fix tests')
    expect(second.document).toContain('npm test')
  })

  it('scales continuation summary output budget with evidence size', () => {
    expect(continuationSummaryTokenBudget(20_000, 'normal')).toBe(2_200)
    expect(continuationSummaryTokenBudget(320_000, 'normal')).toBeGreaterThan(2_200)
    expect(continuationSummaryTokenBudget(1_000_000, 'qualityFirst')).toBeLessThanOrEqual(8_000)
  })

  it('extracts text from raw JSON responses for all supported protocols', () => {
    expect(extractContinuationText('openai_chat', JSON.stringify({ choices: [{ message: { content: 'chat summary' } }] }))).toBe('chat summary')
    expect(extractContinuationText('openai_responses', JSON.stringify({ output_text: 'responses summary' }))).toBe('responses summary')
    expect(extractContinuationText('anthropic_messages', JSON.stringify({ content: [{ type: 'text', text: 'anthropic summary' }] }))).toBe('anthropic summary')
  })
})
