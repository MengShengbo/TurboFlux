import type { ConversationPendingPaste } from '../../conversations/types'

export const LARGE_PASTE_CHAR_THRESHOLD = 1000

export function createPendingPastePlaceholder(
  text: string,
  pendingPastes: readonly ConversationPendingPaste[],
): string {
  const base = `[Pasted Content ${Array.from(text).length} chars]`
  let placeholder = base
  let suffix = 2
  while (pendingPastes.some(pending => pending.placeholder === placeholder)) {
    placeholder = `${base} #${suffix}`
    suffix += 1
  }
  return placeholder
}

export function replacePastedText(
  value: string,
  pastedText: string,
  insertionStart: number,
  placeholder: string,
): string {
  const start = Math.max(0, Math.min(insertionStart, value.length))
  const end = Math.min(value.length, start + pastedText.length)
  if (value.slice(start, end) !== pastedText) return value
  return `${value.slice(0, start)}${placeholder}${value.slice(end)}`
}

export function retainPendingPastes(
  value: string,
  pendingPastes: readonly ConversationPendingPaste[],
): ConversationPendingPaste[] {
  return pendingPastes
    .filter(pending => typeof pending.placeholder === 'string'
      && typeof pending.text === 'string'
      && value.includes(pending.placeholder))
    .map(pending => ({ ...pending }))
}

export function expandPendingPastes(
  value: string,
  pendingPastes: readonly ConversationPendingPaste[],
): string {
  if (pendingPastes.length === 0) return value
  const pendingByPlaceholder = new Map(
    pendingPastes
      .filter(pending => typeof pending.placeholder === 'string' && typeof pending.text === 'string')
      .map(pending => [pending.placeholder, pending.text]),
  )
  const alternatives = [...pendingByPlaceholder.keys()]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
  if (alternatives.length === 0) return value
  return value.replace(new RegExp(alternatives.join('|'), 'g'), match => pendingByPlaceholder.get(match) ?? match)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
