import {Easing, interpolate} from 'remotion';

export const clamp = (value: number) => Math.max(0, Math.min(1, value));

export const curves = {
  heroEnter: Easing.bezier(0.16, 1, 0.3, 1),
  heroExit: Easing.bezier(0.7, 0, 0.84, 0),
  camera: Easing.bezier(0.65, 0, 0.35, 1),
  micro: Easing.bezier(0.2, 0.8, 0.2, 1),
  editorial: Easing.bezier(0.45, 0, 0.55, 1),
} as const;

export const phase = (
  frame: number,
  fps: number,
  start: number,
  duration: number,
  easing: (value: number) => number = curves.editorial,
) => interpolate(
  frame,
  [start * fps, (start + duration) * fps],
  [0, 1],
  {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing},
);

export const enterExit = (
  frame: number,
  fps: number,
  duration: number,
  enterDuration = 0.6,
  exitDuration = 0.5,
) => {
  const enter = phase(frame, fps, 0, enterDuration, curves.heroEnter);
  const exit = phase(frame, fps, duration - exitDuration, exitDuration, curves.heroExit);
  return enter * (1 - exit);
};

export const reveal = (text: string, value: number) => text.slice(0, Math.floor(text.length * clamp(value)));

export const stagger = (frame: number, fps: number, index: number, start: number, gap = 0.1, duration = 0.45) => (
  phase(frame, fps, start + index * gap, duration, curves.heroEnter)
);

export const pulse = (time: number, center: number, width: number) => {
  const distance = Math.abs(time - center);
  return distance >= width ? 0 : 1 - distance / width;
};

export const mix = (from: number, to: number, value: number) => from + (to - from) * clamp(value);
