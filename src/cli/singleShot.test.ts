import { describe, expect, it } from 'vitest'
import type { AgentEventType } from '../core/agentEngine'
import { SingleShotProgressReporter } from './singleShot'

describe('single-shot progress reporting', () => {
  it('reports request time before any real reasoning arrives', () => {
    const output: string[] = []
    let now = 1_000
    const reporter = new SingleShotProgressReporter(text => output.push(text), false, () => now)

    reporter.handle({ type: 'run:state', state: { phase: 'thinking', updatedAt: now } })
    reporter.handle({ type: 'stream:start' })
    now += 1_250
    reporter.handle({ type: 'stream:end' })

    const rendered = output.join('')
    expect(rendered).toContain('[requesting]')
    expect(rendered).toContain('[request complete · 1.3s]')
    expect(rendered).not.toContain('[thinking]')
  })

  it('starts a fresh request timer after a tool loop', () => {
    const output: string[] = []
    let now = 1_000
    const reporter = new SingleShotProgressReporter(text => output.push(text), false, () => now)

    reporter.handle({ type: 'run:state', state: { phase: 'thinking', updatedAt: now } })
    reporter.handle({ type: 'stream:start' })
    now += 500
    reporter.handle({ type: 'stream:end' })
    reporter.handle({ type: 'run:state', state: { phase: 'tool_running', updatedAt: now } })
    now += 250
    reporter.handle({ type: 'run:state', state: { phase: 'thinking', updatedAt: now } })
    reporter.handle({ type: 'stream:start' })
    now += 1_500
    reporter.handle({ type: 'stream:end' })

    const rendered = output.join('')
    expect(rendered.match(/\[requesting\]/g)).toHaveLength(2)
    expect(rendered).toContain('[request complete · 500ms]')
    expect(rendered).toContain('[request complete · 1.5s]')
  })

  it('emits compact lifecycle updates without dumping large tool arguments', () => {
    const output: string[] = []
    let now = 1_000
    const reporter = new SingleShotProgressReporter(text => output.push(text), false, () => now)

    reporter.start('gpt-test', 'C:\\workspace')
    reporter.handle({ type: 'run:state', state: { phase: 'running', updatedAt: now } } as AgentEventType)
    reporter.handle({
      type: 'tool:call',
      toolCall: { id: 'tool-1', name: 'write_file', arguments: { path: 'src/app.ts', content: 'secret'.repeat(500) } },
    })
    now += 1_250
    reporter.handle({
      type: 'tool:result',
      toolResult: { toolCallId: 'tool-1', name: 'write_file', output: 'done', isError: false },
    })
    now += 5_000
    reporter.handle({ type: 'stream:thinking_delta', text: 'working' })

    const rendered = output.join('')
    expect(rendered).toContain('[TurboFlux] gpt-test')
    expect(rendered).toContain('[running]')
    expect(rendered).toContain('→ write_file · src/app.ts')
    expect(rendered).toContain('✓ write_file · 1.3s')
    expect(rendered).toContain('[thinking]')
    expect(rendered).not.toContain('secret')
  })

  it('surfaces failures and truncates multiline output', () => {
    const output: string[] = []
    const reporter = new SingleShotProgressReporter(text => output.push(text))

    reporter.handle({
      type: 'tool:result',
      toolResult: { toolCallId: 'missing', name: 'git_commit', output: `bad\n${'x'.repeat(300)}`, isError: true },
    })

    expect(output.join('')).toContain('✗ git_commit · bad ')
    expect(output.join('').length).toBeLessThan(220)
  })

  it('prints tool-loop commentary and deduplicates the matching notification', () => {
    const output: string[] = []
    const reporter = new SingleShotProgressReporter(text => output.push(text))
    const message = 'Repository mapping is complete; next I am patching validation.'

    reporter.handle({
      type: 'turn:complete',
      turn: {
        id: 'assistant-progress',
        role: 'assistant',
        content: '',
        timestamp: 1,
        toolCalls: [{ id: 'notify-1', name: 'notify_user', arguments: { message } }],
      },
    })
    reporter.handle({ type: 'notification', message, level: 'info' })

    expect(output.join('')).toContain(message)
    expect(output.filter(entry => entry.includes(message))).toHaveLength(1)
  })
})
