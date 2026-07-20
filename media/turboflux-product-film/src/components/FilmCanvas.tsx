import type {ReactNode} from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {BRAND} from '../design';

export const FilmCanvas = ({children}: {children: ReactNode}) => {
  const frame = useCurrentFrame();
  const grainX = (frame * 17) % 180;
  const grainY = (frame * 11) % 180;

  return (
    <AbsoluteFill style={{background: BRAND.paper, color: BRAND.ink, fontFamily: BRAND.font, overflow: 'hidden'}}>
      {children}
      <AbsoluteFill style={{
        pointerEvents: 'none',
        opacity: 0.018,
        transform: `translate(${grainX - 90}px, ${grainY - 90}px)`,
        inset: -100,
        backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=%220 0 180 180%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22n%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%22.9%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23n)%22 opacity=%22.7%22/%3E%3C/svg%3E")',
      }} />
    </AbsoluteFill>
  );
};
