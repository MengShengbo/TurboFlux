export const TASK_COMPLETION_CHIME = {
  durationMs: 720,
  masterGain: 0.18,
  notes: [
    {
      atMs: 0,
      frequency: 493.88,
      durationMs: 430,
      gain: 0.5,
      pan: -0.08,
      partials: [
        { ratio: 1, gain: 1, decay: 1 },
        { ratio: 2.01, gain: 0.18, decay: 0.5 },
        { ratio: 3.97, gain: 0.055, decay: 0.26 },
      ],
    },
    {
      atMs: 92,
      frequency: 659.26,
      durationMs: 520,
      gain: 0.42,
      pan: 0.08,
      partials: [
        { ratio: 1, gain: 1, decay: 1 },
        { ratio: 2.01, gain: 0.16, decay: 0.46 },
        { ratio: 3.97, gain: 0.045, decay: 0.24 },
      ],
    },
  ],
  transient: {
    durationMs: 20,
    gain: 0.035,
    frequency: 2_100,
    q: 0.72,
  },
  room: {
    durationMs: 410,
    gain: 0.055,
    decay: 7.2,
  },
} as const

export type TaskCompletionEvent = { type: string; status?: string }

export function shouldPlayTaskCompletionSound(event: TaskCompletionEvent): boolean {
  return event.type === 'conversation-run' && event.status === 'completed'
}
