import {Audio, Sequence, staticFile} from 'remotion';
import {FilmCanvas} from './components/FilmCanvas';
import {ContinuityScene} from './scenes/ContinuityScene';
import {EndScene} from './scenes/EndScene';
import {ExecutionScene} from './scenes/ExecutionScene';
import {FastContextScene} from './scenes/FastContextScene';
import {IntentScene} from './scenes/IntentScene';
import {ModelScene} from './scenes/ModelScene';
import {SignalScene} from './scenes/SignalScene';
import {VerificationScene} from './scenes/VerificationScene';
import {secondsToFrames, SHOTS} from './timeline';

const Shot = ({shot, children}: {shot: {start: number; duration: number}; children: React.ReactNode}) => (
  <Sequence from={secondsToFrames(shot.start)} durationInFrames={secondsToFrames(shot.duration)} premountFor={30}>
    {children}
  </Sequence>
);

export const EnterpriseFilm = () => (
  <FilmCanvas>
    <Audio src={staticFile('audio/turboflux-score.mp3')} volume={1} />
    <Shot shot={SHOTS.signal}><SignalScene /></Shot>
    <Shot shot={SHOTS.intent}><IntentScene /></Shot>
    <Shot shot={SHOTS.fastContext}><FastContextScene /></Shot>
    <Shot shot={SHOTS.execution}><ExecutionScene /></Shot>
    <Shot shot={SHOTS.verification}><VerificationScene /></Shot>
    <Shot shot={SHOTS.continuity}><ContinuityScene /></Shot>
    <Shot shot={SHOTS.model}><ModelScene /></Shot>
    <Shot shot={SHOTS.end}><EndScene /></Shot>
  </FilmCanvas>
);
