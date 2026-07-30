import { describe, expect, it } from 'vitest'
import { TerminalInputStateMachine } from './terminalInputStateMachine'

describe('TerminalInputStateMachine', () => {
  it('classifies rapid Windows key events as a paste burst', () => {
    const state = new TerminalInputStateMachine()
    state.notePlainText('a', 0)
    state.notePlainText('b', 4)
    expect(state.notePlainText('c', 8)).toMatchObject({ mode: 'paste-burst', consecutivePlainChars: 3 })
    expect(state.shouldInsertNewline(100)).toBe(true)
    expect(state.shouldInsertNewline(129)).toBe(false)
  })

  it('lets ordinary slower typing submit normally', () => {
    const state = new TerminalInputStateMachine()
    state.notePlainText('a', 0)
    state.notePlainText('b', 20)

    expect(state.getSnapshot().mode).toBe('typing')
    expect(state.shouldInsertNewline(30)).toBe(false)
  })

  it('does not hold non-ASCII IME output while guarding an immediate Enter', () => {
    const state = new TerminalInputStateMachine()
    expect(state.notePlainText('测', 50).mode).toBe('composing')
    expect(state.shouldInsertNewline(56)).toBe(true)
    expect(state.shouldInsertNewline(70)).toBe(false)
  })

  it('recognizes explicit and multi-character paste payloads immediately', () => {
    const state = new TerminalInputStateMachine()
    expect(state.notePlainText('many chars', 10).mode).toBe('paste-burst')
    state.reset()
    expect(state.noteExplicitPaste('a\nb', 20).mode).toBe('paste-burst')
  })

  it('clears paste classification before modified or navigation input', () => {
    const state = new TerminalInputStateMachine()
    state.noteExplicitPaste('abc', 0)
    state.noteModifiedOrNavigationInput()

    expect(state.getSnapshot()).toEqual({
      mode: 'idle',
      consecutivePlainChars: 0,
      lastPlainTextAt: null,
      newlineGuardUntil: null,
    })
  })
})
