import { describe, expect, it } from 'vitest'
import {
  createPendingPastePlaceholder,
  expandPendingPastes,
  replacePastedText,
  retainPendingPastes,
} from './pasteState'

describe('pasteState', () => {
  it('creates unique placeholders for repeated paste sizes', () => {
    const first = createPendingPastePlaceholder('a'.repeat(1001), [])
    const second = createPendingPastePlaceholder('b'.repeat(1001), [{ placeholder: first, text: 'a'.repeat(1001) }])

    expect(first).toBe('[Pasted Content 1001 chars]')
    expect(second).toBe('[Pasted Content 1001 chars] #2')
  })

  it('replaces a paste at the insertion point', () => {
    const pastedText = 'a'.repeat(1001)
    const value = `prefix${pastedText}suffix`
    const placeholder = '[Pasted Content 1001 chars]'

    expect(replacePastedText(value, pastedText, 6, placeholder)).toBe(`prefix${placeholder}suffix`)
  })

  it('expands multiple placeholders in one pass', () => {
    const pending = [
      { placeholder: '[Pasted Content 1001 chars]', text: 'first\nlog' },
      { placeholder: '[Pasted Content 1200 chars] #2', text: 'second\nlog' },
    ]

    expect(expandPendingPastes('A [Pasted Content 1001 chars] B [Pasted Content 1200 chars] #2', pending))
      .toBe('A first\nlog B second\nlog')
  })

  it('does not recursively expand placeholder-looking text inside pasted content', () => {
    const placeholder = '[Pasted Content 1001 chars]'
    const pending = [{ placeholder, text: `literal ${placeholder}` }]

    expect(expandPendingPastes(placeholder, pending)).toBe(`literal ${placeholder}`)
  })

  it('retains only placeholders still present in the draft', () => {
    const pending = [
      { placeholder: '[Pasted Content 1001 chars]', text: 'first' },
      { placeholder: '[Pasted Content 1200 chars]', text: 'second' },
    ]

    expect(retainPendingPastes('keep [Pasted Content 1001 chars]', pending)).toEqual([pending[0]])
  })
})
