import { describe, expect, it } from 'vitest'
import type { AgentTurn } from '../shared/agentTypes'
import type { ContextHandoff, ContextSegment } from '../state/types'
import {
  buildContextHandoff,
  buildContinuationEvidence,
  buildContinuationSummaryAnchors,
  buildDeterministicContinuationSummary,
  collectContinuationHandoffFacts,
  validateContinuationSummary,
} from './contextCompaction'
import { ContextManager } from './contextManager'
import { DefaultAgentStateProvider } from './runtime/stateProvider'

function makeLargeCompactionTurns(cycle: number, pairs = 72): AgentTurn[] {
  const turns: AgentTurn[] = [{
    id: `u-${cycle}-goal`,
    role: 'user',
    content: `INITIAL_ANCHOR cycle-${cycle}: preserve delivery state and edit STRESS_REQ_${cycle}`,
    timestamp: cycle * 10_000,
  }]

  for (let index = 0; index < pairs; index += 1) {
    const isEdit = index % 9 === 0
    const tool = isEdit ? 'apply_patch' : 'read_file'
    const path = isEdit
      ? `src/core/stress-${cycle}-edit-${index}.ts`
      : `src/core/stress-${cycle}-read-${index % 12}.ts`
    const callId = `tc-${cycle}-${index}`
    turns.push({
      id: `a-${cycle}-${index}`,
      role: 'assistant',
      content: index % 16 === 0 ? `Progress checkpoint ${cycle}/${index}: still on compression work.` : '',
      timestamp: cycle * 10_000 + index * 2 + 1,
      toolCalls: [{ id: callId, name: tool, arguments: { path, offset: index * 10 } }],
    })
    turns.push({
      id: `tr-${cycle}-${index}`,
      role: 'tool_result',
      content: '',
      timestamp: cycle * 10_000 + index * 2 + 2,
      toolResults: [{
        toolCallId: callId,
        name: tool,
        output: `output-${cycle}-${index}\n${'x'.repeat(4_500)}`,
        isError: false,
        changeSummary: isEdit
          ? {
              path,
              operation: 'edit',
              before: 'before'.repeat(200),
              after: 'after'.repeat(200),
              preview: `patched ${path}`,
            }
          : undefined,
      }],
    })
  }

  return turns
}

function compactOnce(
  cycle: number,
  previous: ContextHandoff | null,
): ContextHandoff {
  const oldTurns = makeLargeCompactionTurns(cycle)
  const recentTurns: AgentTurn[] = [{
    id: `u-${cycle}-resume`,
    role: 'user',
    content: `STRESS_REQ_${cycle}: continue after compression without restarting prior work`,
    timestamp: cycle * 10_000 + 9_000,
  }]
  const workspace = {
    workspacePath: 'C:/repo',
    gitStatus: ` M src/core/stress-${cycle}-edit-0.ts\n?? scripts/stress-${cycle}.mjs`,
    taskTree: [{ id: `task-${cycle}`, status: 'in_progress', title: `stress cycle ${cycle}` }],
    activeTask: { id: `task-${cycle}`, next: `resume STRESS_REQ_${cycle}` },
  }
  const facts = collectContinuationHandoffFacts(oldTurns, recentTurns, workspace, previous?.facts)
  const summary = buildDeterministicContinuationSummary(facts, previous?.modelSummary)
  const anchors = buildContinuationSummaryAnchors(facts)
  const validation = validateContinuationSummary(summary, anchors)
  expect(validation).toMatchObject({ valid: true, missing: [] })

  const evidence = buildContinuationEvidence(oldTurns, recentTurns, workspace, previous)
  expect(evidence.length).toBeGreaterThan(300_000)
  if (previous) expect(evidence).toContain('previous_development_handoff')

  return buildContextHandoff({
    oldTurns,
    recentTurns,
    workspace,
    previous,
    modelSummary: summary,
    startMessageId: oldTurns[0]!.id,
    endMessageId: oldTurns.at(-1)!.id,
    source: 'compact',
    summarySource: 'deterministic',
    facts,
  })
}

function segmentFromHandoff(handoff: ContextHandoff): ContextSegment {
  return {
    startMessageId: handoff.startMessageId,
    endMessageId: handoff.endMessageId,
    summary: handoff.modelSummary,
    isModelGenerated: true,
    kind: 'compact',
    originalCharCount: 1_000_000,
    isValid: true,
    createdAt: handoff.createdAt,
    coveredTurnIds: handoff.coveredTurnIds,
    handoff,
  }
}

describe('context compaction stress', () => {
  it('keeps a bounded durable handoff over repeated large compactions', () => {
    let handoff: ContextHandoff | null = null
    for (let cycle = 1; cycle <= 6; cycle += 1) {
      handoff = compactOnce(cycle, handoff)

      expect(handoff.revision).toBe(cycle)
      expect(handoff.compactDocument.length).toBeLessThanOrEqual(20_000)
      expect(handoff.document.length).toBeLessThanOrEqual(64_000)
      expect(handoff.document).toContain(`STRESS_REQ_${cycle}`)
      expect(handoff.document).toContain(`src/core/stress-${cycle}-edit-0.ts`)
    }

    expect(handoff?.document).toContain('INITIAL_ANCHOR cycle-1')
    expect(handoff?.coveredTurnIds.length).toBeGreaterThan(400)
  })

  it('retains only the newest heavyweight handoff in normalized state', () => {
    const first = compactOnce(1, null)
    const second = compactOnce(2, first)
    const provider = new DefaultAgentStateProvider({
      provider: 'custom',
      apiKey: 'test',
      baseUrl: 'http://example.test',
      model: 'test-model',
      contextWindow: 200_000,
      maxTokens: 4096,
    }, 'C:/repo')

    provider.setContextSegments([segmentFromHandoff(first), segmentFromHandoff(second)])

    const segments = provider.getContextSegments()
    expect(segments).toHaveLength(1)
    expect(segments[0]?.handoff?.revision).toBe(2)
    expect(segments[0]?.coveredTurnIds).toEqual(second.coveredTurnIds)
  })

  it('injects the newest handoff while many old summaries exist', () => {
    let latest: ContextHandoff | null = null
    const segments: ContextSegment[] = []
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      latest = compactOnce(cycle, latest)
      segments.push(segmentFromHandoff(latest))
    }

    const manager = new ContextManager()
    const messages = manager.buildMessages(
      [{ id: 'live-user', role: 'user', content: 'resume from stress checkpoint', timestamp: 99_999 }],
      'system prompt',
      220_000,
      'openai',
      4096,
      segments,
      undefined,
      'gpt-5.5',
    )
    const joined = messages.map(message => String(message.content)).join('\n')

    expect(joined).toContain('<development_handoff_checkpoint>')
    expect(joined).toContain('STRESS_REQ_4')
    expect(joined).toContain('compressed_conversation_history')
  })
})
