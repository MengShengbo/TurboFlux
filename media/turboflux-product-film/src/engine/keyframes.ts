import {interpolate} from 'remotion';
import {curve, type CurveName} from './motion';

export type ScalarKeyframe = {at: number; value: number; velocity?: number; easeIn?: CurveName; easeOut?: CurveName};

const hermite = (t: number, from: ScalarKeyframe, to: ScalarKeyframe) => {
  const duration = to.at - from.at;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * from.value + (t3 - 2 * t2 + t) * (from.velocity ?? 0) * duration + (-2 * t3 + 3 * t2) * to.value + (t3 - t2) * (to.velocity ?? 0) * duration;
};

export const sampleScalarTrack = ({frame, fps, keyframes}: {frame: number; fps: number; keyframes: ScalarKeyframe[]}) => {
  const time = frame / fps;
  if (time <= keyframes[0].at) return keyframes[0].value;
  if (time >= keyframes[keyframes.length - 1].at) return keyframes[keyframes.length - 1].value;
  const index = keyframes.findIndex((item) => item.at >= time);
  const from = keyframes[index - 1];
  const to = keyframes[index];
  const local = (time - from.at) / (to.at - from.at);
  if (from.velocity !== undefined || to.velocity !== undefined) return hermite(local, from, to);
  return interpolate(local, [0, 1], [from.value, to.value], {easing: curve(from.easeOut ?? to.easeIn ?? 'editorial')});
};
