import { describe, expect, it } from 'vitest'
import { parseTextToolCalls, stripTextToolCallMarkup } from './toolCallMarkup'

describe('text tool call markup', () => {
  it('parses plain XML-ish tool calls emitted as assistant text', () => {
    const parsed = parseTextToolCalls(`<tool_calls>
<invoke name="get_codemap">
<parameter name="depth" string="false">2</parameter>
</invoke>
<invoke name="list_directory">
<parameter name="path">.</parameter>
</invoke>
</tool_calls>`)

    expect(parsed.cleanedText).toBe('')
    expect(parsed.toolCalls).toHaveLength(2)
    expect(parsed.toolCalls[0]?.name).toBe('get_codemap')
    expect(parsed.toolCalls[0]?.arguments).toEqual({ depth: 2 })
    expect(parsed.toolCalls[1]?.name).toBe('list_directory')
    expect(parsed.toolCalls[1]?.arguments).toEqual({ path: '.' })
  })

  it('parses DeepSeek DSML text tool calls', () => {
    const parsed = parseTextToolCalls(`<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="read_file">
<｜｜DSML｜｜parameter name="path">README.md</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`)

    expect(parsed.toolCalls).toHaveLength(1)
    expect(parsed.toolCalls[0]?.name).toBe('read_file')
    expect(parsed.toolCalls[0]?.arguments).toEqual({ path: 'README.md' })
  })

  it('hides leaked internal runtime context blocks from display', () => {
    const text = `visible reply
<runtime_context>
internal strategy that should never render
</runtime_context>
done`

    expect(stripTextToolCallMarkup(text)).toBe('visible reply\n\ndone')
  })

  it('hides incomplete markup from the streaming display', () => {
    expect(stripTextToolCallMarkup('好的。\n<tool_calls>\n<invoke', { stripIncomplete: true })).toBe('好的。')
  })
})
