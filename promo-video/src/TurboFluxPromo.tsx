import React from 'react';
import {AbsoluteFill, Audio, Sequence, staticFile} from 'remotion';
import {AgentsScene, GitScene, IntroScene, OutroScene, PermissionScene, WorkbenchScene} from './scenes';

export const TurboFluxPromo: React.FC = () => (
  <AbsoluteFill style={{background: '#050505'}}>
    <Audio src={staticFile('audio/turboflux-score.wav')} volume={0.82} />
    <Sequence from={0} durationInFrames={145}><IntroScene /></Sequence>
    <Sequence from={145} durationInFrames={181}><WorkbenchScene /></Sequence>
    <Sequence from={326} durationInFrames={204}><AgentsScene /></Sequence>
    <Sequence from={530} durationInFrames={161}><PermissionScene /></Sequence>
    <Sequence from={691} durationInFrames={209}><GitScene /></Sequence>
    <Sequence from={900} durationInFrames={180}><OutroScene /></Sequence>
    <AbsoluteFill style={{pointerEvents: 'none', opacity: .16, background: 'linear-gradient(180deg, rgba(255,255,255,.025), transparent 18%, transparent 82%, rgba(0,0,0,.3))'}} />
  </AbsoluteFill>
);
