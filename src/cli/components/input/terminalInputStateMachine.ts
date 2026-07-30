export type TerminalInputMode = 'idle' | 'typing' | 'composing' | 'paste-burst'

export interface TerminalInputSnapshot {
  mode: TerminalInputMode
  consecutivePlainChars: number
  lastPlainTextAt: number | null
  newlineGuardUntil: number | null
}

export interface TerminalInputStateMachineOptions {
  charIntervalMs?: number
  minimumBurstChars?: number
  newlineGuardMs?: number
}

export class TerminalInputStateMachine {
  private readonly charIntervalMs: number
  private readonly minimumBurstChars: number
  private readonly newlineGuardMs: number
  private mode: TerminalInputMode = 'idle'
  private consecutivePlainChars = 0
  private lastPlainTextAt: number | null = null
  private newlineGuardUntil: number | null = null

  constructor(options: TerminalInputStateMachineOptions = {}) {
    this.charIntervalMs = Math.max(1, options.charIntervalMs ?? 8)
    this.minimumBurstChars = Math.max(2, options.minimumBurstChars ?? 3)
    this.newlineGuardMs = Math.max(1, options.newlineGuardMs ?? 120)
  }

  notePlainText(text: string, at = Date.now()): TerminalInputSnapshot {
    const characters = Array.from(text)
    if (characters.length === 0) return this.getSnapshot()
    const continuesBurst = this.lastPlainTextAt !== null && at - this.lastPlainTextAt <= this.charIntervalMs
    this.consecutivePlainChars = continuesBurst
      ? this.consecutivePlainChars + characters.length
      : characters.length
    this.lastPlainTextAt = at

    const pasteLike = characters.length > 1 || this.consecutivePlainChars >= this.minimumBurstChars
    if (pasteLike) {
      this.mode = 'paste-burst'
      this.newlineGuardUntil = at + this.newlineGuardMs
    } else {
      this.mode = characters.some(character => character.codePointAt(0)! > 0x7f) ? 'composing' : 'typing'
    }
    return this.getSnapshot()
  }

  noteExplicitPaste(text: string, at = Date.now()): TerminalInputSnapshot {
    this.mode = 'paste-burst'
    this.consecutivePlainChars = Math.max(this.minimumBurstChars, Array.from(text).length)
    this.lastPlainTextAt = at
    this.newlineGuardUntil = at + this.newlineGuardMs
    return this.getSnapshot()
  }

  shouldInsertNewline(at = Date.now()): boolean {
    const immediatePlainText = this.lastPlainTextAt !== null && at - this.lastPlainTextAt <= this.charIntervalMs
    return immediatePlainText || (this.newlineGuardUntil !== null && at <= this.newlineGuardUntil)
  }

  noteInsertedNewline(at = Date.now()): void {
    this.mode = 'paste-burst'
    this.lastPlainTextAt = at
    this.newlineGuardUntil = at + this.newlineGuardMs
  }

  noteModifiedOrNavigationInput(): void {
    this.mode = 'idle'
    this.consecutivePlainChars = 0
    this.lastPlainTextAt = null
    this.newlineGuardUntil = null
  }

  reset(): void {
    this.noteModifiedOrNavigationInput()
  }

  getSnapshot(): TerminalInputSnapshot {
    return {
      mode: this.mode,
      consecutivePlainChars: this.consecutivePlainChars,
      lastPlainTextAt: this.lastPlainTextAt,
      newlineGuardUntil: this.newlineGuardUntil,
    }
  }
}
