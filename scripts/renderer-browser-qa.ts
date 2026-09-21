import { RenderScheduler } from '@turboflux/renderer'
import { createFallbackLinearMessage, createLinearTaskFlowRenderer } from '@turboflux/renderer/linearTaskFlow'
import { renderMarkdown } from '@turboflux/renderer/richContent'
import { TranscriptIndex, type TaskFlowNode, type TaskFlowProjectionState, type ToolResult } from '@turboflux/presentation'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

async function run() {
  document.documentElement.dataset.theme = 'dark'
  const host = document.querySelector<HTMLElement>('#transcript')!
  const results: string[] = []
  const index = new TranscriptIndex()
  const call = { id: 'call-1', name: 'run_command', arguments: { command: 'npm test' } }
  let result: ToolResult = { toolCallId: call.id, output: 'PASS before', isError: false }
  index.setCall(call); index.setResult(result)
  const renderer = createLinearTaskFlowRenderer(host, {
    createInput: node => createFallbackLinearMessage(node, 'user'),
    createAnswer: node => createFallbackLinearMessage(node, 'assistant'),
    resolveTool: () => ({ call, result }),
    nodeVersion: node => node.callId ? String(index.toolVersion(node.callId)) : '',
  })
  function node(id: string, kind: TaskFlowNode['kind'], content: string): TaskFlowNode {
    return { id, kind, content, ordinal: 1, phase: 'delivery', status: 'completed', settled: true, createdAt: 1, updatedAt: 1 }
  }
  const state: TaskFlowProjectionState = {
    conversationId: 'qa', source: 'work', revision: 1, lastSeq: 1, sequenceGaps: [],
    nodes: { input: node('input', 'input', '验证 TurboFlux 渲染引擎'), thinking: node('thinking', 'thinking', '检查流式输出与工具结果。'), tool: { ...node('tool', 'tool', 'run_command'), callId: call.id, toolName: call.name }, answer: node('answer', 'answer', '旧版内容') },
    order: ['input', 'thinking', 'tool', 'answer'],
  }
  renderer.render(state)
  const answer = host.querySelector('[data-task-flow-node-id="answer"]')!
  assert(answer, 'Answer mounted')
  state.nodes = { ...state.nodes, answer: { ...state.nodes.answer, content: '新版内容' } }
  renderer.render(state)
  assert(host.querySelector('[data-task-flow-node-id="answer"]') === answer, 'Retain answer row identity')
  assert(answer.textContent?.includes('新版内容'), 'Update same-length answer correction')
  results.push('same-length correction and stable DOM identity')
  const tool = host.querySelector<HTMLElement>('.linear-tool')!
  assert(tool, 'Tool result mounted')
  tool.querySelector<HTMLButtonElement>('.linear-disclosure-row')!.click()
  assert(tool.classList.contains('expanded'), 'Expand tool details')
  result = { ...result, output: 'PASS after!' }; index.setResult(result)
  renderer.render(state)
  const updated = host.querySelector<HTMLElement>('.linear-tool')!
  assert(updated.classList.contains('expanded'), 'Retain expansion after result update')
  assert(updated.textContent?.includes('PASS after!'), 'Paint corrected result')
  results.push('tool result update retains disclosure')
  let paints = 0
  const scheduler = new RenderScheduler()
  for (let i = 0; i < 1000; i++) {
    state.nodes = { ...state.nodes, answer: { ...state.nodes.answer, content: `流式输出 ${i}`, status: 'running', settled: false } }
    scheduler.schedule('transcript', () => { paints++; renderer.render(state) })
  }
  await frame()
  assert(paints === 1 && answer.textContent?.includes('999'), 'Batch 1000 stream updates into one paint')
  results.push('1000 stream updates coalesce into one paint')
  state.order = ['answer', 'input', 'thinking', 'tool']
  renderer.render(state)
  assert(host.firstElementChild === answer, 'Reorder existing row without remount')
  results.push('keyed reorder')
  const markdown = document.createElement('section'); document.body.append(markdown)
  renderMarkdown(markdown, '<script>window.compromised=true</script><img src="x" onerror="window.compromised=true"><a href="javascript:alert(1)">unsafe</a>')
  assert(!markdown.querySelector('script, [onerror], [href^="javascript:"]'), 'Sanitize unsafe Markdown')
  markdown.remove(); results.push('Markdown sanitization')
  scheduler.schedule('transcript', () => { paints++ })
  scheduler.dispose(); await frame(); assert(paints === 1, 'Cancel paint on unmount')
  renderer.clear(); assert(!host.childElementCount, 'Remove retained rows on unmount')
  results.push('unmount cancels scheduled paint and releases rows')
  state.nodes = { ...state.nodes, answer: { ...state.nodes.answer, content: '渲染引擎验证完成。\n\n流式更新、工具结果、节点复用与资源释放均通过。', status: 'completed', settled: true } }
  state.order = ['input', 'thinking', 'tool', 'answer']; renderer.render(state)
  return { ok: true, checks: results, streamUpdates: 1000, paints }
}

;(window as unknown as { qaResult: Promise<unknown> }).qaResult = run()
