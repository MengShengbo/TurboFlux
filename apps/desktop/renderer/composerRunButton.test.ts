import { describe, expect, it } from 'vitest'
import { presentComposerRunButton } from './composerRunButton'

describe('composer run button presentation', () => {
  it('disables the send action when the draft is empty', () => {
    expect(presentComposerRunButton({
      runtimeStatus: 'ready',
      submissionPending: false,
      hasDraftInput: false,
      interactionLocked: false,
    })).toEqual({
      action: 'send',
      disabled: true,
      icon: 'sendUp',
      title: '输入内容后发送',
    })
  })

  it('enables the send action for text or attachments', () => {
    expect(presentComposerRunButton({
      runtimeStatus: 'ready',
      submissionPending: false,
      hasDraftInput: true,
      interactionLocked: false,
    })).toMatchObject({ action: 'send', disabled: false, icon: 'sendUp' })
  })

  it('keeps pause dominant while a task is starting or running', () => {
    expect(presentComposerRunButton({
      runtimeStatus: 'ready',
      submissionPending: true,
      hasDraftInput: false,
      interactionLocked: false,
    })).toMatchObject({ action: 'pause', disabled: false, icon: 'pauseBlock' })
    expect(presentComposerRunButton({
      runtimeStatus: 'running',
      submissionPending: false,
      hasDraftInput: true,
      interactionLocked: false,
    })).toMatchObject({ action: 'pause', disabled: false, icon: 'pauseBlock' })
  })

  it('offers resume after the task is paused', () => {
    expect(presentComposerRunButton({
      runtimeStatus: 'paused',
      submissionPending: false,
      hasDraftInput: true,
      interactionLocked: false,
    })).toEqual({
      action: 'resume',
      disabled: false,
      icon: 'play',
      title: '继续当前任务',
    })
  })

  it('treats an awaiting-action task as a reply composer', () => {
    expect(presentComposerRunButton({
      runtimeStatus: 'awaiting-action',
      submissionPending: false,
      hasDraftInput: false,
      interactionLocked: false,
    })).toMatchObject({ action: 'send', disabled: true })
    expect(presentComposerRunButton({
      runtimeStatus: 'awaiting-action',
      submissionPending: false,
      hasDraftInput: true,
      interactionLocked: false,
    })).toMatchObject({ action: 'send', disabled: false })
  })
})
