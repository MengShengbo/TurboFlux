import React from 'react';
import {Composition} from 'remotion';
import {TurboFluxPromo} from './TurboFluxPromo';

export const Root: React.FC = () => (
  <Composition
    id="TurboFluxPromo"
    component={TurboFluxPromo}
    durationInFrames={1080}
    fps={30}
    width={1920}
    height={1080}
  />
);
