import { describe, expect, it } from 'vitest'
import type { AgentEventType } from '../../core/agentEngine'
import type { AgentTurn, ToolCall, ToolResult } from '../../shared/agentTypes'
import type { ContextSegment } from '../../state/types'
import type { PersistedConversation } from '../conversations/types'
import {
  COMPUTER_ERROR_REDACTED,
  COMPUTER_DETAIL_REDACTED,
  COMPUTER_RESULT_REDACTED,
  redactComputerActiveTask,
  redactComputerAgentEvent,
  redactComputerConversation,
  redactComputerToolCall,
} from './computerPrivacy'

const sensitiveValues = [
  'PRIVATE_TYPED_TEXT',
  'PRIVATE_KEYS',
  'PRIVATE_AX_VALUE',
  '/private/tmp/computer-frame.png',
  'observation-private',
  'ax-private-ref',
  '424242',
  '321.25',
  '654.75',
]

function computerCall(): ToolCall {
  return {
    id: 'computer-call-1',
    name: 'computer__type_text',
    arguments: {
      text: 'PRIVATE_TYPED_TEXT',
      keys: 'PRIVATE_KEYS',
      x: 321.25,
      y: 654.75,
      pid: 424242,
      ref: 'ax-private-ref',
      observation_id: 'observation-private',
      app_name: 'Private App',
    },
  }
}

function computerResult(): ToolResult {
  return {
    toolCallId: 'computer-call-1',
    name: 'computer__type_text',
    output: JSON.stringify({ value: 'PRIVATE_AX_VALUE', pid: 424242, x: 321.25, y: 654.75 }),
    isError: false,
    attachments: [{
      id: 'computer-frame-1',
      type: 'image',
      path: '/private/tmp/computer-frame.png',
      mime: 'image/png',
      filename: 'computer-frame.png',
      size: 123,
    }],
  }
}

function expectNoComputerSecrets(value: unknown): void {
  const serialized = JSON.stringify(value)
  for (const sensitive of sensitiveValues) expect(serialized).not.toContain(sensitive)
}

describe('computer privacy projection', () => {
  it('redacts tool payloads without mutating the live runtime values', () => {
    const call = computerCall()
    const result = computerResult()
    const callEvent = redactComputerAgentEvent({ type: 'tool:call', toolCall: call })
    const resultEvent = redactComputerAgentEvent({ type: 'tool:result', toolResult: result })

    expectNoComputerSecrets([callEvent, resultEvent])
    expect(callEvent).toMatchObject({ toolCall: { arguments: {} } })
    expect(resultEvent).toMatchObject({
      toolResult: {
        output: COMPUTER_RESULT_REDACTED,
        isError: false,
      },
    })
    expect((resultEvent as Extract<AgentEventType, { type: 'tool:result' }>).toolResult.attachments).toBeUndefined()
    expect(call.arguments.text).toBe('PRIVATE_TYPED_TEXT')
    expect(result.attachments?.[0]?.path).toBe('/private/tmp/computer-frame.png')
  })

  it('redacts partial tool JSON, sessions, task results, reservoirs, and compacted context', () => {
    const call = computerCall()
    const result = computerResult()
    const assistant: AgentTurn = { id: 'assistant-1', role: 'assistant', content: '', timestamp: 101, toolCalls: [call] }
    const resultTurn: AgentTurn = {
      id: 'result-1',
      role: 'tool_result',
      content: `computer__type_text: [ok] ${result.output}`,
      timestamp: 102,
      toolResults: [result],
    }
    const segment: ContextSegment = {
      startMessageId: assistant.id,
      endMessageId: resultTurn.id,
      coveredTurnIds: [assistant.id, resultTurn.id],
      summary: `Observed PRIVATE_AX_VALUE at /private/tmp/computer-frame.png`,
      isModelGenerated: true,
      originalCharCount: 500,
      isValid: true,
      handoff: {
        version: 1,
        revision: 1,
        createdAt: 103,
        startMessageId: assistant.id,
        endMessageId: resultTurn.id,
        coveredTurnIds: [assistant.id, resultTurn.id],
        source: 'compact',
        summarySource: 'model',
        modelSummary: 'PRIVATE_AX_VALUE',
        facts: {
          userRequirements: [],
          files: [],
          commands: [],
          decisions: [],
          errors: [{ toolCallId: call.id, tool: call.name, summary: 'PRIVATE_AX_VALUE' }],
          progress: [{ turnId: assistant.id, text: 'PRIVATE_TYPED_TEXT' }],
          workspace: { activeTask: 'PRIVATE_AX_VALUE' },
        },
        document: 'PRIVATE_AX_VALUE',
        compactDocument: 'PRIVATE_AX_VALUE',
      },
    }
    const conversation: PersistedConversation = {
      id: 'conversation-1',
      title: 'Privacy test',
      workspacePath: '/workspace',
      createdAt: 100,
      updatedAt: 103,
      mode: 'vibe',
      model: 'test-model',
      provider: 'custom',
      turnCount: 2,
      turns: [assistant, resultTurn],
      activeTurns: [assistant, resultTurn],
      contextSegments: [segment],
      contextReservoir: [{
        id: 'reservoir-1',
        startMessageId: assistant.id,
        endMessageId: resultTurn.id,
        turns: [assistant, resultTurn],
        source: 'compact',
        originalCharCount: 500,
      }],
    }

    const projected = redactComputerConversation(conversation)
    const delta = redactComputerAgentEvent({
      type: 'stream:tool_call_delta',
      toolCallId: call.id,
      toolName: call.name,
      partialJson: JSON.stringify(call.arguments),
    })
    const task = redactComputerActiveTask({
      taskId: 'task-1',
      title: 'Use app',
      priority: 'major',
      progress: 50,
      startedAt: 100,
      toolCalls: [{
        toolCallId: call.id,
        toolName: call.name,
        status: 'error',
        path: '/private/tmp/computer-frame.png',
        result: 'PRIVATE_AX_VALUE',
      }],
    })

    expectNoComputerSecrets([projected, delta, task])
    expect(delta).toMatchObject({ partialJson: '{}' })
    expect(projected.turns[0]?.toolCalls?.[0]?.arguments).toEqual({})
    expect(projected.turns[1]?.toolResults?.[0]).toMatchObject({ output: COMPUTER_RESULT_REDACTED })
    expect(projected.contextSegments?.[0]).toMatchObject({
      summary: `Observed ${COMPUTER_DETAIL_REDACTED} at ${COMPUTER_DETAIL_REDACTED}`,
      handoff: {
        modelSummary: COMPUTER_DETAIL_REDACTED,
        document: COMPUTER_DETAIL_REDACTED,
      },
    })
    expect(task?.toolCalls[0]).toMatchObject({ result: COMPUTER_ERROR_REDACTED })
  })

  it('leaves non-computer tool calls unchanged', () => {
    const toolCall: ToolCall = { id: 'read-1', name: 'read_file', arguments: { path: 'README.md' } }
    expect(redactComputerToolCall(toolCall)).toBe(toolCall)
  })
})
