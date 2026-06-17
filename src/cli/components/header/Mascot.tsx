export type MascotMood = 'idle' | 'thinking' | 'happy' | 'error'

const LOGO_IDLE: string[] = [
  ' ▀▀█▀▀ ▀▀█▀▀ ',
  '   █   █▀▀   ',
  '   █   █     ',
  '   ▀   ▀     ',
]

const LOGO_THINKING: string[][] = [
  [
    ' ▀▀█▀▀ ▀▀█▀▀ ',
    '   █   █▀▀  ·',
    '   █   █     ',
    '   ▀   ▀     ',
  ],
  [
    ' ▀▀█▀▀ ▀▀█▀▀ ',
    '   █   █▀▀  ✢',
    '   █   █     ',
    '   ▀   ▀     ',
  ],
  [
    ' ▀▀█▀▀ ▀▀█▀▀ ',
    '   █   █▀▀  ✳',
    '   █   █     ',
    '   ▀   ▀     ',
  ],
]

const LOGO_HAPPY: string[] = [
  ' ▀▀█▀▀ ▀▀█▀▀ ',
  '   █   █▀▀  ✓',
  '   █   █     ',
  '   ▀   ▀     ',
]

const LOGO_ERROR: string[] = [
  ' ▀▀█▀▀ ▀▀█▀▀ ',
  '   █   █▀▀  !',
  '   █   █     ',
  '   ▀   ▀     ',
]

export function renderLogo(mood: MascotMood, frame: number): string[] {
  switch (mood) {
    case 'thinking':
      return LOGO_THINKING[frame % LOGO_THINKING.length]
    case 'happy':
      return LOGO_HAPPY
    case 'error':
      return LOGO_ERROR
    default:
      return LOGO_IDLE
  }
}

export const LOGO_HEIGHT = 4
export const LOGO_WIDTH = 15
