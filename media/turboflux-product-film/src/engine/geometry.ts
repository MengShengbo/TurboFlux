export type Point = {x: number; y: number};
export type Rect = {x: number; y: number; width: number; height: number};
export type AnchorName = 'center' | 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

export const rectAnchor = (rect: Rect, anchor: AnchorName = 'center'): Point => {
  if (anchor === 'topLeft') return {x: rect.x, y: rect.y};
  if (anchor === 'topRight') return {x: rect.x + rect.width, y: rect.y};
  if (anchor === 'bottomLeft') return {x: rect.x, y: rect.y + rect.height};
  if (anchor === 'bottomRight') return {x: rect.x + rect.width, y: rect.y + rect.height};
  return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
};

export const pointInRect = (point: Point, rect: Rect, tolerance = 0) => point.x >= rect.x - tolerance && point.x <= rect.x + rect.width + tolerance && point.y >= rect.y - tolerance && point.y <= rect.y + rect.height + tolerance;

export const transformPoint = ({point, origin, x, y, scale}: {point: Point; origin: Point; x: number; y: number; scale: number}): Point => ({x: origin.x + (point.x - origin.x) * scale + x, y: origin.y + (point.y - origin.y) * scale + y});
