import {Easing, interpolate} from 'remotion';

export type CurveName = 'heroEnter' | 'heroExit' | 'cameraGlide' | 'microUI' | 'editorial' | 'pointerMove';

export const curve = (name: CurveName) => {
  if (name === 'heroEnter') return Easing.bezier(0.16, 1, 0.3, 1);
  if (name === 'heroExit') return Easing.bezier(0.7, 0, 0.84, 0);
  if (name === 'cameraGlide') return Easing.bezier(0.65, 0, 0.35, 1);
  if (name === 'microUI') return Easing.bezier(0.2, 0.8, 0.2, 1);
  if (name === 'pointerMove') return Easing.bezier(0.22, 0.61, 0.36, 1);
  return Easing.bezier(0.45, 0, 0.55, 1);
};

export const progress = ({frame, fps, start, duration, easing}: {frame: number; fps: number; start: number; duration: number; easing: CurveName}) => interpolate(frame, [start * fps, (start + duration) * fps], [0, 1], {easing: curve(easing), extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
