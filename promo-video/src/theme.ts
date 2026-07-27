import {Easing, interpolate} from 'remotion';

export const C = {
  bg: '#050505',
  panel: '#0A0A0A',
  panel2: '#141414',
  line: '#303030',
  lineSoft: '#202020',
  cyan: '#67E8F9',
  info: '#22D3EE',
  green: '#78FF5F',
  white: '#F1F1F1',
  muted: '#999999',
  dim: '#606060',
  yellow: '#FFD166',
  red: '#FF4D6D',
};

export const mono = '"Cascadia Code", "Cascadia Mono", Consolas, monospace';

export const clamp = (value: number) => Math.max(0, Math.min(1, value));

export const ease = (frame: number, from: number, to: number) =>
  interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

export const linear = (frame: number, from: number, to: number) =>
  interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

export const fadeWindow = (frame: number, inStart = 0, inEnd = 10, outStart = 9999, outEnd = 10000) =>
  interpolate(frame, [inStart, inEnd, outStart, outEnd], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
