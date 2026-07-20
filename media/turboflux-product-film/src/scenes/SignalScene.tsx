import {useCurrentFrame, useVideoConfig} from 'remotion';
import {BRAND} from '../design';
import {curves, phase} from '../motion';

const Mark = ({progress}: {progress: number}) => (
  <div style={{width: 64, height: 64, border: `2px solid ${BRAND.ink}`, borderRadius: 14, display: 'grid', placeItems: 'center', transform: `scale(${0.86 + progress * 0.14})`, opacity: progress}}>
    <div style={{fontFamily: BRAND.mono, fontSize: 29, fontWeight: 800, color: BRAND.accent}}>&gt;</div>
  </div>
);

export const SignalScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const mark = phase(frame, fps, 0.45, 1.1, curves.heroEnter);
  const name = phase(frame, fps, 2.4, 1.05, curves.heroEnter);
  const nameOut = phase(frame, fps, 5.0, 0.55, curves.heroExit);
  const promise = phase(frame, fps, 5.45, 0.95, curves.heroEnter);
  const exit = phase(frame, fps, 8.25, 0.65, curves.heroExit);

  return (
    <div style={{position: 'absolute', inset: 0, background: BRAND.paperBright, display: 'grid', placeItems: 'center', opacity: 1 - exit}}>
      <div style={{position: 'absolute', top: 336, opacity: mark * (1 - nameOut), transform: `translateY(${(1 - mark) * 18 - nameOut * 16}px)`}}><Mark progress={mark} /></div>
      <div style={{position: 'absolute', top: 462, fontSize: 72, fontWeight: 720, letterSpacing: 0, opacity: name * (1 - nameOut), transform: `translateY(${(1 - name) * 24 - nameOut * 18}px)`}}>TurboFlux</div>
      <div style={{position: 'absolute', left: 260, right: 260, top: 448, textAlign: 'center', fontSize: 52, lineHeight: 1.28, fontWeight: 680, letterSpacing: 0, opacity: promise, transform: `translateY(${(1 - promise) * 34}px)`}}>
        把复杂工程任务，交给一个可验证的 Agent 工作流。
      </div>
    </div>
  );
};
