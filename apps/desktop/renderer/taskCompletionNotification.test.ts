import { describe, expect, it } from 'vitest'
import {
  taskCompletionNotificationDelivery,
  taskCompletionNotificationPresentation,
} from '../taskCompletionNotification'

describe('task completion notification', () => {
  it('presents only successful conversation completions', () => {
    expect(taskCompletionNotificationPresentation({
      type: 'conversation-run',
      conversationId: 'conversation-1',
      status: 'completed',
    }, '整理会议纪要')).toEqual({
      title: '任务已完成',
      body: '整理会议纪要 已完成，点击查看结果。',
      taskTitle: '整理会议纪要',
    })
    expect(taskCompletionNotificationPresentation({ type: 'conversation-run', status: 'failed' })).toBeNull()
    expect(taskCompletionNotificationPresentation({ type: 'conversation-run', status: 'interrupted' })).toBeNull()
    expect(taskCompletionNotificationPresentation({ type: 'snapshot' })).toBeNull()
  })

  it('keeps system notification text compact and useful', () => {
    const fallback = taskCompletionNotificationPresentation({ type: 'conversation-run', status: 'completed' }, '   ')
    const long = taskCompletionNotificationPresentation(
      { type: 'conversation-run', status: 'completed' },
      `  ${'很长的任务名称 '.repeat(20)}  `,
    )

    expect(fallback?.body).toBe('这个任务 已完成，点击查看结果。')
    expect(long?.taskTitle).toHaveLength(72)
    expect(long?.taskTitle.endsWith('…')).toBe(true)
    expect(long?.taskTitle).not.toMatch(/\s{2,}/)
  })

  it('includes a compact plain-text preview of the final Agent reply', () => {
    const presentation = taskCompletionNotificationPresentation({
      type: 'conversation-run',
      status: 'completed',
      resultSummary: '## 已完成\n\n**报告**已生成。[下载文件](https://example.com/report)已放入交付目录。第三句不应出现。',
    }, '整理项目报告')

    expect(presentation).toMatchObject({
      title: '任务已完成',
      taskTitle: '整理项目报告',
      agentPreview: '已完成 报告已生成。下载文件已放入交付目录。',
      body: '整理项目报告\n已完成 报告已生成。下载文件已放入交付目录。',
    })
  })

  it('always pushes the system notification but requests extra attention only in background', () => {
    const completed = { type: 'conversation-run', status: 'completed' }
    expect(taskCompletionNotificationDelivery(completed, true)).toEqual({
      showSystemNotification: true,
      requestBackgroundAttention: false,
    })
    expect(taskCompletionNotificationDelivery(completed, false)).toEqual({
      showSystemNotification: true,
      requestBackgroundAttention: true,
    })
    expect(taskCompletionNotificationDelivery({ type: 'conversation-run', status: 'failed' }, false)).toEqual({
      showSystemNotification: false,
      requestBackgroundAttention: false,
    })
  })
})
