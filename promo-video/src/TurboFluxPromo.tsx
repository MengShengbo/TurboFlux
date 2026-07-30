import React from 'react';
import {AbsoluteFill, Audio, Sequence, staticFile} from 'remotion';
import {AgentsScene, FastContextScene, GitScene, IntroScene, OutroScene, PermissionScene, WorkbenchScene} from './scenes';

export const TurboFluxPromo: React.FC = () => (
  <AbsoluteFill style={{background: '#050505'}}>
    <Audio src={staticFile('audio/turboflux-score.wav')} volume={0.82} />
    <Sequence from={0} durationInFrames={145}><IntroScene /></Sequence>
    <Sequence from={145} durationInFrames={131}><WorkbenchScene /></Sequence>
    <Sequence from={276} durationInFrames={145}><FastContextScene /></Sequence>
    <Sequence from={421} durationInFrames={174}><AgentsScene /></Sequence>
    <Sequence from={595} durationInFrames={131}><PermissionScene /></Sequence>
    <Sequence from={726} durationInFrames={174}><GitScene /></Sequence>
    <Sequence from={900} durationInFrames={180}><OutroScene /></Sequence>
    <AbsoluteFill style={{pointerEvents: 'none', opacity: .16, background: 'linear-gradient(180deg, rgba(255,255,255,.025), transparent 18%, transparent 82%, rgba(0,0,0,.3))'}} />
  </AbsoluteFill>
);
