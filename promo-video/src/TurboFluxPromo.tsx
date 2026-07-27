import React from 'react';
import {AbsoluteFill, Audio, Sequence, staticFile} from 'remotion';
import {AgentsScene, FastContextScene, GitScene, IntroScene, OutroScene, PermissionScene, WorkbenchScene} from './scenes';

export const TurboFluxPromo: React.FC = () => (
  <AbsoluteFill style={{background: '#050505'}}>
    <Audio src={staticFile('audio/turboflux-score.wav')} volume={0.82} />
    <Sequence from={0} durationInFrames={135}><IntroScene /></Sequence>
    <Sequence from={135} durationInFrames={135}><WorkbenchScene /></Sequence>
    <Sequence from={270} durationInFrames={150}><FastContextScene /></Sequence>
    <Sequence from={420} durationInFrames={170}><AgentsScene /></Sequence>
    <Sequence from={590} durationInFrames={130}><PermissionScene /></Sequence>
    <Sequence from={720} durationInFrames={180}><GitScene /></Sequence>
    <Sequence from={900} durationInFrames={180}><OutroScene /></Sequence>
    <AbsoluteFill style={{pointerEvents: 'none', opacity: .16, background: 'linear-gradient(180deg, rgba(255,255,255,.025), transparent 18%, transparent 82%, rgba(0,0,0,.3))'}} />
  </AbsoluteFill>
);
