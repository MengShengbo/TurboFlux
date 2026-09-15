export type ComposerPopoverPlacement = 'above' | 'below'

interface AnchorRect {
  top: number
  right: number
  bottom: number
  left: number
  width: number
}

interface ViewportSize {
  width: number
  height: number
}

export interface AnchoredPopoverPosition {
  placement: ComposerPopoverPlacement
  left: number
  width: number
  top: number | null
  bottom: number | null
  maxHeight: number
  transformOrigin: string
}

export function composerPopoverPlacement(conversationMode: boolean): ComposerPopoverPlacement {
  return conversationMode ? 'above' : 'below'
}

export function anchoredComposerPopoverPosition(
  anchor: AnchorRect,
  viewport: ViewportSize,
  requestedWidth: number,
  placement: ComposerPopoverPlacement,
  gap = 8,
  margin = 14,
): AnchoredPopoverPosition {
  const width = Math.max(0, Math.min(requestedWidth, viewport.width - (margin * 2)))
  const desiredLeft = anchor.left + ((anchor.width - width) / 2)
  const left = Math.min(Math.max(margin, desiredLeft), viewport.width - width - margin)
  if (placement === 'below') {
    const top = anchor.bottom + gap
    return {
      placement,
      left,
      width,
      top,
      bottom: null,
      maxHeight: Math.max(96, viewport.height - top - margin),
      transformOrigin: 'top right',
    }
  }
  const bottom = Math.max(margin, viewport.height - anchor.top + gap)
  return {
    placement,
    left,
    width,
    top: null,
    bottom,
    maxHeight: Math.max(96, anchor.top - gap - margin),
    transformOrigin: 'bottom right',
  }
}
