import { describe, expect, it } from 'vitest'
import {
  browserToolActionTitle,
  browserToolResultDetail,
  normalizeThinkingContent,
  setThinkingBlockExpanded,
} from './richContent'

describe('normalizeThinkingContent', () => {
  it('keeps collapsed reasoning out of the accessibility tree', () => {
    const attributes = {
      toggle: new Map<string, string>(),
      body: new Map<string, string>(),
    }
    const block = {
      classList: { toggle: () => undefined },
      querySelector: (selector: string) => ({
        setAttribute: (name: string, value: string) => {
          attributes[selector === '.thinking-toggle' ? 'toggle' : 'body'].set(name, value)
        },
      }),
    } as unknown as HTMLElement

    setThinkingBlockExpanded(block, true)
    expect(attributes.toggle.get('aria-expanded')).toBe('true')
    expect(attributes.body.get('aria-hidden')).toBe('false')

    setThinkingBlockExpanded(block, false)
    expect(attributes.toggle.get('aria-expanded')).toBe('false')
    expect(attributes.body.get('aria-hidden')).toBe('true')
  })

  it('removes partial fenced-code markers without dropping reasoning text', () => {
    expect(normalizeThinkingContent('先确认结构。\n\n```js\nconst ready = true\n')).toBe('先确认结构。\n\nconst ready = true')
  })

  it('keeps the content of completed fences as continuous reasoning', () => {
    expect(normalizeThinkingContent('分析：\n```scss\n.row { display: grid }\n```\n继续检查。')).toBe('分析：\n\n.row { display: grid }\n\n继续检查。')
  })

  it('hides raw tool-call protocol from the visible reasoning trace', () => {
    expect(normalizeThinkingContent('先检查文件。\n<tool_calls>\n<invoke name="read_file">\n<parameter name="path">a.ts</parameter>\n</invoke>\n</tool_calls>\n继续分析。')).toBe('先检查文件。\n\n继续分析。')
  })

  it('removes retry protocol and corrupted dense model rows', () => {
    expect(normalizeThinkingContent([
      '先确认工作区。',
      '<tool_retry_hint>The last tool call failed: list_directory</tool_retry_hint>',
      'row5: ....RRRRRRRR.... <帽子row6: ...RRWWRRRR.... <帽檐+脸顶部row7: ...WWWWRRRRR...',
      '接下来创建主文件。',
    ].join('\n'))).toBe('先确认工作区。\n\n接下来创建主文件。')
  })

  it('shows the browser action that actually completed', () => {
    expect(browserToolActionTitle('browser__open')).toBe('打开网页')
    expect(browserToolActionTitle('browser__navigate')).toBe('前往页面')
    expect(browserToolActionTitle('browser__wait')).toBe('等待网页加载')
    expect(browserToolActionTitle('browser__observe')).toBe('读取网页')
    expect(browserToolActionTitle('browser__screenshot')).toBe('截取网页')
    expect(browserToolActionTitle('browser__find')).toBe('查找页面控件')
    expect(browserToolActionTitle('browser__click')).toBe('点击网页内容')
    expect(browserToolActionTitle('browser__reload')).toBe('刷新网页')
    expect(browserToolActionTitle('browser__close')).toBe('关闭网页')
    expect(browserToolResultDetail('browser__click', {
      toolCallId: 'click-1',
      name: 'browser__click',
      output: JSON.stringify({ clicked: '全部接受', changed: true }),
      isError: false,
    })).toBe('已点击「全部接受」 · 页面已更新')
  })
})
