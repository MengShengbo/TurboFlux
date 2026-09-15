export function trapProfileDialogFocus(event: KeyboardEvent, dialog: HTMLElement): void {
  if (event.key !== 'Tab') return
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
  if (focusable.length === 0) return
  const first = focusable[0]!
  const last = focusable.at(-1)!
  const activeElement = dialog.ownerDocument?.activeElement
  if (event.shiftKey && activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

export function handleProfileDialogEscape(
  event: KeyboardEvent,
  canClose: boolean,
  close: () => void,
): boolean {
  if (event.key !== 'Escape' || !canClose) return false
  event.preventDefault()
  event.stopPropagation()
  close()
  return true
}

export interface ProfileDialogReturnFocusTarget {
  element: HTMLElement
  actionAttribute?: string
  actionIndex?: number
}

export function captureProfileDialogReturnFocus(element: Element | null): ProfileDialogReturnFocusTarget | null {
  if (!(element instanceof HTMLElement)) return null
  const actionAttribute = Array.from(element.attributes).find(attribute => attribute.name.startsWith('data-profile-'))?.name
  if (!actionAttribute) return { element }
  const matches = Array.from(element.ownerDocument.querySelectorAll<HTMLElement>(`[${actionAttribute}]`))
  return { element, actionAttribute, actionIndex: Math.max(0, matches.indexOf(element)) }
}

export function restoreProfileDialogReturnFocus(target: ProfileDialogReturnFocusTarget | null): void {
  if (!target) return
  if (target.element.isConnected) {
    target.element.focus({ preventScroll: true })
    return
  }
  if (!target.actionAttribute) return
  const matches = Array.from(target.element.ownerDocument.querySelectorAll<HTMLElement>(`[${target.actionAttribute}]`))
  const replacement = matches[target.actionIndex || 0] || matches[0]
  replacement?.focus({ preventScroll: true })
}
