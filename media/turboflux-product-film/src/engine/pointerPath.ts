import {interpolate} from 'remotion';
import type {Point} from './geometry';
import {curve} from './motion';

const cubic = (from: Point, control1: Point, control2: Point, to: Point, t: number): Point => {
  const inverse = 1 - t;
  return {x: inverse ** 3 * from.x + 3 * inverse ** 2 * t * control1.x + 3 * inverse * t ** 2 * control2.x + t ** 3 * to.x, y: inverse ** 3 * from.y + 3 * inverse ** 2 * t * control1.y + 3 * inverse * t ** 2 * control2.y + t ** 3 * to.y};
};

const length = (from: Point, to: Point) => Math.hypot(to.x - from.x, to.y - from.y);

const sampleDistance = (points: Point[], progressValue: number): Point => {
  const lengths = points.slice(1).map((point, index) => length(points[index], point));
  const target = lengths.reduce((sum, value) => sum + value, 0) * progressValue;
  let traveled = 0;
  for (let index = 0; index < lengths.length; index++) {
    if (traveled + lengths[index] >= target) {
      const local = lengths[index] === 0 ? 0 : (target - traveled) / lengths[index];
      return {x: interpolate(local, [0, 1], [points[index].x, points[index + 1].x]), y: interpolate(local, [0, 1], [points[index].y, points[index + 1].y])};
    }
    traveled += lengths[index];
  }
  return points[points.length - 1];
};

export const samplePointerPath = ({frame, fps, start, duration, from, to, arc = 0.16}: {frame: number; fps: number; start: number; duration: number; from: Point; to: Point; arc?: number}) => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const normal = {x: -dy * arc, y: dx * arc};
  const control1 = {x: from.x + dx * 0.34 + normal.x, y: from.y + dy * 0.34 + normal.y};
  const control2 = {x: from.x + dx * 0.72 + normal.x * 0.45, y: from.y + dy * 0.72 + normal.y * 0.45};
  const points = Array.from({length: 49}, (_, index) => cubic(from, control1, control2, to, index / 48));
  const value = interpolate(frame, [start * fps, (start + duration) * fps], [0, 1], {easing: curve('pointerMove'), extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return sampleDistance(points, value);
};

export const clickPulse = ({frame, fps, at}: {frame: number; fps: number; at: number}) => interpolate(frame, [(at - 0.08) * fps, at * fps, (at + 0.14) * fps], [0, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
