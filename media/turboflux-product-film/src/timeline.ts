export const FILM = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationSeconds: 58,
  durationInFrames: 1740,
} as const;

export const SHOTS = {
  signal: {start: 0, duration: 4.8},
  intent: {start: 4.8, duration: 7},
  fastContext: {start: 11.8, duration: 8.4},
  execution: {start: 20.2, duration: 8.8},
  verification: {start: 29, duration: 8.8},
  continuity: {start: 37.8, duration: 7.7},
  model: {start: 45.5, duration: 6.5},
  end: {start: 52, duration: 6},
} as const;

export const secondsToFrames = (seconds: number) => Math.round(seconds * FILM.fps);
