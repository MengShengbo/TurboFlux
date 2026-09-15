import { describe, expect, it } from 'vitest'
import { presentTaskCompanion } from './taskCompanion'

describe('presentTaskCompanion', () => {
  it('stays absent when a task has no companion content', () => {
    expect(presentTaskCompanion({ active: true })).toEqual({ visible: false, items: [] })
  })

  it('stays absent outside the active task lifecycle', () => {
    expect(presentTaskCompanion({
      active: false,
      preview: { title: '本地预览', detail: '运行中' },
    })).toEqual({ visible: false, items: [] })
  })

  it('keeps one primary state and at most two contextual entry points', () => {
    expect(presentTaskCompanion({
      active: true,
      work: { title: '正在验证', detail: '2 个步骤' },
      preview: { title: '本地预览', detail: '应用预览' },
      browser: { title: '正在浏览', detail: 'OpenAI · 3 个页面' },
      subagents: { total: 3, running: 2, completed: 1 },
      computer: { title: '电脑操作', detail: 'Keynote', attention: true },
    })).toEqual({
      visible: true,
      items: [
        { kind: 'work', title: '正在验证', detail: '2 个步骤' },
        { kind: 'computer', title: '电脑操作', detail: 'Keynote', attention: true },
        { kind: 'subagents', title: '协作代理', detail: '2 运行中 · 1 已完成' },
      ],
    })
  })

  it('shows only one browser surface and prefers an errored browser over preview', () => {
    expect(presentTaskCompanion({
      active: true,
      preview: { title: '本地预览', detail: '应用预览' },
      browser: { title: '浏览器需要处理', detail: '页面加载失败', attention: true },
    }).items).toEqual([
      { kind: 'browser', title: '浏览器需要处理', detail: '页面加载失败', attention: true },
    ])
  })
})
