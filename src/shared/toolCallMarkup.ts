import type { ToolCall } from './agentTypes'

export interface TextToolCallParseResult {
  toolCalls: ToolCall[]
  cleanedText: string
  containsToolMarkup: boolean
}

const COMPLETE_TOOL_BLOCKS = [
  /<\s*tool_calls\s*>[\s\S]*?<\s*\/\s*tool_calls\s*>/gi,
  /<\s*invoke\b[^>]*>[\s\S]*?<\s*\/\s*invoke\s*>/gi,
  /<｜｜DSML｜｜tool_calls>[\s\S]*?<\/｜｜DSML｜｜tool_calls>/g,
  /<｜｜DSML｜｜invoke\b[^>]*>[\s\S]*?<\/｜｜DSML｜｜invoke>/g,
]

const TOOL_MARKUP_START = /<\s*(?:tool_calls|invoke)\b|<｜｜DSML｜｜(?:tool_calls|invoke)\b/i

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function getAttr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(['"])(.*?)\\1`, 'i').exec(attrs)
  return match?.[2]
}

function coerceParameterValue(rawValue: string, attrs: string): unknown {
  const value = decodeEntities(rawValue.trim())
  const stringAttr = getAttr(attrs, 'string')?.toLowerCase()
  const typeAttr = getAttr(attrs, 'type')?.toLowerCase()
  const jsonAttr = getAttr(attrs, 'json')?.toLowerCase()
  const shouldParse =
    stringAttr === 'false' ||
    jsonAttr === 'true' ||
    typeAttr === 'json' ||
    typeAttr === 'object' ||
    typeAttr === 'array' ||
    typeAttr === 'number' ||
    typeAttr === 'integer' ||
    typeAttr === 'boolean' ||
    /^[\[{"]/.test(value)

  if (shouldParse) {
    try {
      return JSON.parse(value)
    } catch {
      if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
      if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true'
      if (value === 'null') return null
    }
  }

  return value
}

function parseInvokes(text: string, invokeRegex: RegExp, parameterRegex: RegExp): ToolCall[] {
  const toolCalls: ToolCall[] = []
  let invokeMatch: RegExpExecArray | null

  while ((invokeMatch = invokeRegex.exec(text)) !== null) {
    const invokeAttrs = invokeMatch[1] ?? ''
    const name = getAttr(invokeAttrs, 'name')
    if (!name) continue

    const body = invokeMatch[2] ?? ''
    const args: Record<string, unknown> = {}
    parameterRegex.lastIndex = 0

    let paramMatch: RegExpExecArray | null
    while ((paramMatch = parameterRegex.exec(body)) !== null) {
      const paramAttrs = paramMatch[1] ?? ''
      const paramName = getAttr(paramAttrs, 'name')
      if (!paramName) continue
      args[paramName] = coerceParameterValue(paramMatch[2] ?? '', paramAttrs)
    }

    toolCalls.push({
      id: `text_tool_${Date.now()}_${toolCalls.length}`,
      name,
      arguments: args,
    })
  }

  return toolCalls
}

export function stripTextToolCallMarkup(
  text: string,
  options: { stripIncomplete?: boolean } = {},
): string {
  let cleaned = text
  for (const pattern of COMPLETE_TOOL_BLOCKS) {
    cleaned = cleaned.replace(pattern, '')
  }

  if (options.stripIncomplete) {
    const start = cleaned.search(TOOL_MARKUP_START)
    if (start >= 0) cleaned = cleaned.slice(0, start)
  }

  return cleaned.trim()
}

export function parseTextToolCalls(text: string): TextToolCallParseResult {
  const plainCalls = parseInvokes(
    text,
    /<\s*invoke\b([^>]*)>([\s\S]*?)<\s*\/\s*invoke\s*>/gi,
    /<\s*parameter\b([^>]*)>([\s\S]*?)<\s*\/\s*parameter\s*>/gi,
  )
  const dsmlCalls = parseInvokes(
    text,
    /<｜｜DSML｜｜invoke\b([^>]*)>([\s\S]*?)<\/｜｜DSML｜｜invoke>/g,
    /<｜｜DSML｜｜parameter\b([^>]*)>([\s\S]*?)<\/｜｜DSML｜｜parameter>/g,
  )
  const toolCalls = [...plainCalls, ...dsmlCalls]
  const containsToolMarkup = toolCalls.length > 0 || TOOL_MARKUP_START.test(text)

  return {
    toolCalls,
    cleanedText: stripTextToolCallMarkup(text),
    containsToolMarkup,
  }
}
