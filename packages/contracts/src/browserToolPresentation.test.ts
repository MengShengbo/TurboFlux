import { describe, expect, it } from 'vitest'
import {
  browserPermissionGrantGroup,
  browserToolNeedsApproval,
  describeBrowserPermission,
  describeBrowserToolActivity,
  isBuiltInBrowserTool,
} from './browserToolPresentation'

describe('browser tool product presentation', () => {
  it.each(['capabilities', 'inspect', 'mark_deliverable', 'mark_handoff'])('keeps %s free of action approval prompts', operation => {
    expect(browserToolNeedsApproval(`browser__${operation}`)).toBe(false)
  })

  it('presents browser work without exposing MCP tool names or sensitive typed text', () => {
    expect(describeBrowserToolActivity('browser__visual_observe', {}, 'running')).toEqual({
      title: '查看页面画面',
      detail: '正在查看当前画面',
      needsApproval: false,
    })
    const typing = describeBrowserToolActivity('browser__type', { text: 'private value' }, 'running')
    expect(typing?.detail).toBe('正在填写页面内容')
    expect(JSON.stringify(typing)).not.toContain('private value')
    expect(describeBrowserToolActivity('browser__find', { query: '全部接受' }, 'completed')).toEqual({
      title: '查找页面控件',
      detail: '已找到可操作内容 · “全部接受”',
      needsApproval: false,
    })
  })

  it('separates low-risk observation from page-changing actions', () => {
    expect(browserToolNeedsApproval('browser__observe')).toBe(false)
    expect(browserToolNeedsApproval('browser__visual_observe')).toBe(false)
    expect(browserToolNeedsApproval('browser__scroll')).toBe(false)
    expect(browserToolNeedsApproval('browser__set_layout')).toBe(false)
    expect(browserToolNeedsApproval('browser__click')).toBe(true)
    expect(browserToolNeedsApproval('browser__type')).toBe(true)
    expect(browserPermissionGrantGroup('browser__click')).toBe('browser-actions')
    expect(isBuiltInBrowserTool('files__read')).toBe(false)
  })

  it('creates natural approval copy for consequential browser actions', () => {
    expect(describeBrowserPermission('browser__type', { text: 'secret' })).toEqual({
      title: '填写网页',
      question: '允许 TurboFlux 在当前网页填写内容吗？',
      reason: '这会把内容填写到当前网页，可能向网站发送信息。',
      runningDetail: '正在填写页面内容',
    })
    expect(describeBrowserPermission('browser__observe', {})).toBeNull()
  })
})
