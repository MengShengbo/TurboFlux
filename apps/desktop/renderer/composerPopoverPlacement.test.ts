import { describe, expect, it } from 'vitest'
import {
  anchoredComposerPopoverPosition,
  composerPopoverPlacement,
} from './composerPopoverPlacement'

describe('composer popover placement', () => {
  it('opens below the floating welcome composer and above the docked conversation composer', () => {
    expect(composerPopoverPlacement(false)).toBe('below')
    expect(composerPopoverPlacement(true)).toBe('above')
  })

  it('keeps a welcome picker below its anchor without covering the composer', () => {
    const position = anchoredComposerPopoverPosition(
      { top: 320, right: 760, bottom: 360, left: 680, width: 80 },
      { width: 1200, height: 900 },
      276,
      'below',
    )
    expect(position.top).toBe(368)
    expect(position.bottom).toBeNull()
    expect(position.transformOrigin).toBe('top right')
  })

  it('keeps a conversation picker above its anchor and inside the viewport', () => {
    const position = anchoredComposerPopoverPosition(
      { top: 820, right: 1160, bottom: 850, left: 1080, width: 80 },
      { width: 1200, height: 900 },
      372,
      'above',
    )
    expect(position.top).toBeNull()
    expect(position.bottom).toBe(88)
    expect(position.left).toBe(814)
    expect(position.transformOrigin).toBe('bottom right')
  })
})
