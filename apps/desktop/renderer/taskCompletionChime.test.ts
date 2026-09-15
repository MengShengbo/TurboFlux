import { describe, expect, it } from 'vitest'
import { TASK_COMPLETION_CHIME, shouldPlayTaskCompletionSound } from '../taskCompletionSound'

describe('task completion chime', () => {
  it('uses a restrained two-note ascending signature', () => {
    expect(TASK_COMPLETION_CHIME.notes).toHaveLength(2)
    expect(TASK_COMPLETION_CHIME.notes[1].atMs - TASK_COMPLETION_CHIME.notes[0].atMs).toBeGreaterThanOrEqual(80)
    expect(TASK_COMPLETION_CHIME.notes[1].atMs - TASK_COMPLETION_CHIME.notes[0].atMs).toBeLessThanOrEqual(110)
    expect(TASK_COMPLETION_CHIME.notes[1].frequency).toBeGreaterThan(TASK_COMPLETION_CHIME.notes[0].frequency)
    expect(TASK_COMPLETION_CHIME.durationMs).toBeLessThanOrEqual(800)
    expect(TASK_COMPLETION_CHIME.masterGain).toBeLessThanOrEqual(0.2)
  })

  it('adds organic partials and a short subdued room tail', () => {
    expect(TASK_COMPLETION_CHIME.notes.every(note => note.partials.length >= 3)).toBe(true)
    expect(TASK_COMPLETION_CHIME.transient.durationMs).toBeLessThanOrEqual(24)
    expect(TASK_COMPLETION_CHIME.room.durationMs).toBeLessThan(TASK_COMPLETION_CHIME.durationMs)
    expect(TASK_COMPLETION_CHIME.room.gain).toBeLessThan(0.08)
  })

  it('plays only for successful conversation completion', () => {
    expect(shouldPlayTaskCompletionSound({ type: 'conversation-run', status: 'completed' })).toBe(true)
    expect(shouldPlayTaskCompletionSound({ type: 'conversation-run', status: 'failed' })).toBe(false)
    expect(shouldPlayTaskCompletionSound({ type: 'conversation-run', status: 'interrupted' })).toBe(false)
    expect(shouldPlayTaskCompletionSound({ type: 'snapshot' })).toBe(false)
  })
})
