import { describe, expect, it, vi } from 'vitest'
import {
  captureProfileDialogReturnFocus,
  handleProfileDialogEscape,
  restoreProfileDialogReturnFocus,
  trapProfileDialogFocus,
} from './profileDialogAccessibility'

describe('profile archive dialog accessibility', () => {
  it('consumes Escape so a child wizard does not close its parent settings center', () => {
    const close = vi.fn()
    const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent

    expect(handleProfileDialogEscape(event, true, close)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('leaves Escape untouched while an archive operation is active', () => {
    const close = vi.fn()
    const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent

    expect(handleProfileDialogEscape(event, false, close)).toBe(false)
    expect(event.stopPropagation).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('cycles keyboard focus within the modal dialog', () => {
    const first = { hidden: false, getAttribute: () => null, focus: vi.fn() } as unknown as HTMLElement
    const last = { hidden: false, getAttribute: () => null, focus: vi.fn() } as unknown as HTMLElement
    const dialog = { querySelectorAll: () => [first, last], ownerDocument: { activeElement: last } } as unknown as HTMLElement
    const event = { key: 'Tab', shiftKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent

    trapProfileDialogFocus(event, dialog)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(first.focus).toHaveBeenCalledOnce()
  })

  it('restores focus to the equivalent profile action after a refresh', () => {
    class FakeElement {
      attributes = [{ name: 'data-profile-export' }]
      isConnected = true
      focus = vi.fn()
      ownerDocument!: { querySelectorAll(): FakeElement[] }
    }
    vi.stubGlobal('HTMLElement', FakeElement)
    const original = new FakeElement()
    const replacement = new FakeElement()
    let elements = [original]
    const ownerDocument = { querySelectorAll: () => elements }
    original.ownerDocument = ownerDocument
    replacement.ownerDocument = ownerDocument
    const target = captureProfileDialogReturnFocus(original as unknown as Element)

    original.isConnected = false
    elements = [replacement]
    restoreProfileDialogReturnFocus(target)

    expect(replacement.focus).toHaveBeenCalledWith({ preventScroll: true })
    vi.unstubAllGlobals()
  })
})
