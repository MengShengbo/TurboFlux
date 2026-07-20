import type {ReactNode} from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {BRAND} from '../design';

export const FilmCanvas = ({children}: {children: ReactNode}) => {
  const frame = useCurrentFrame();
  const drift = frame % 240;

  return (
    <AbsoluteFill style={{background: BRAND.backgroundDeep, color: BRAND.foreground, fontFamily: BRAND.font, overflow: 'hidden'}}>
      <AbsoluteFill style={{
        opacity: 0.18,
        backgroundImage: `linear-gradient(${BRAND.dividerSoft} 1px, transparent 1px), linear-gradient(90deg, ${BRAND.dividerSoft} 1px, transparent 1px)`,
        backgroundSize: '80px 80px',
        transform: `translateY(${drift / 18}px)`,
      }} />
      <AbsoluteFill style={{
        opacity: 0.07,
        backgroundImage: 'repeating-linear-gradient(0deg, rgba(255,255,255,0.14) 0px, rgba(255,255,255,0.14) 1px, transparent 1px, transparent 4px)',
      }} />
      {children}
      <div style={{position: 'absolute', inset: 0, border: '1px solid rgba(255,255,255,0.06)', pointerEvents: 'none'}} />
    </AbsoluteFill>
  );
};
