export const FILM = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationSeconds: 78,
  durationInFrames: 2340,
} as const;

export const SHOTS = {
  signal: {start: 0, duration: 9},
  intent: {start: 9, duration: 13},
  fastContext: {start: 22, duration: 9},
  execution: {start: 31, duration: 13},
  verification: {start: 44, duration: 12},
  continuity: {start: 56, duration: 9},
  model: {start: 65, duration: 6},
  end: {start: 71, duration: 7},
} as const;

export const secondsToFrames = (seconds: number) => Math.round(seconds * FILM.fps);
