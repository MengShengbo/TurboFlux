export const CANCELLED_TOOL_RESULT_TEXT = 'Cancelled before the tool completed.'

function contentBlocks(message: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(message.content)) {
    return message.content.filter(block => block && typeof block === 'object') as Array<Record<string, unknown>>
  }
  if (typeof message.content === 'string' && message.content) {
    return [{ type: 'text', text: message.content }]
  }
  return []
}

export function normalizeAnthropicToolMessages(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const normalized: Array<Record<string, unknown>> = []

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const blocks = contentBlocks(message)
    const toolUseIds = message.role === 'assistant'
      ? blocks
          .filter(block => block.type === 'tool_use' && typeof block.id === 'string')
          .map(block => block.id as string)
      : []

    if (toolUseIds.length === 0) {
      if (message.role === 'user' && blocks.some(block => block.type === 'tool_result')) {
        const nonToolBlocks = blocks.filter(block => block.type !== 'tool_result')
        if (nonToolBlocks.length > 0) normalized.push({ ...message, content: nonToolBlocks })
      } else {
        normalized.push(message)
      }
      continue
    }

    normalized.push(message)
    const expectedIds = new Set(toolUseIds)
    const resultsById = new Map<string, Record<string, unknown>>()
    const trailingUserBlocks: Array<Record<string, unknown>> = []
    let nextIndex = index + 1

    while (nextIndex < messages.length && messages[nextIndex]?.role === 'user') {
      for (const block of contentBlocks(messages[nextIndex])) {
        const resultId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
        if (block.type === 'tool_result' && expectedIds.has(resultId)) {
          if (!resultsById.has(resultId)) resultsById.set(resultId, block)
        } else if (block.type !== 'tool_result') {
          trailingUserBlocks.push(block)
        }
      }
      nextIndex += 1
    }

    const resultBlocks = toolUseIds.map(toolUseId => resultsById.get(toolUseId) ?? {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: CANCELLED_TOOL_RESULT_TEXT,
      is_error: true,
    })
    normalized.push({ role: 'user', content: [...resultBlocks, ...trailingUserBlocks] })
    index = nextIndex - 1
  }

  return normalized
}

export function appendRuntimeContextToLatestUserMessage(
  messages: Array<Record<string, unknown>>,
  text: string,
  provider: 'openai' | 'anthropic',
): boolean {
  if (!text.trim()) return false

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') continue

    if (typeof message.content === 'string') {
      message.content = `${message.content}\n\n${text}`
      return true
    }

    if (Array.isArray(message.content)) {
      ;(message.content as Array<Record<string, unknown>>).push({
        type: 'text',
        text,
      })
      return true
    }
  }

  return false
}
