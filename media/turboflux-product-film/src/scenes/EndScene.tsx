import {useCurrentFrame, useVideoConfig} from 'remotion';
import {BRAND} from '../design';
import {curves, phase} from '../motion';

export const EndScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const line = phase(frame, fps, 0.2, 1.2, curves.camera);
  const brand = phase(frame, fps, 1.0, 0.9, curves.heroEnter);
  const claim = phase(frame, fps, 2.3, 0.8, curves.heroEnter);
  const repo = phase(frame, fps, 3.7, 0.6, curves.heroEnter);

  return (
    <div style={{position: 'absolute', inset: 0, background: BRAND.paperBright, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center'}}>
      <div style={{width: 74, height: 74, border: `2px solid ${BRAND.ink}`, borderRadius: 16, display: 'grid', placeItems: 'center', opacity: brand, transform: `scale(${0.88 + brand * 0.12})`}}><span style={{fontFamily: BRAND.mono, fontSize: 34, color: BRAND.accent, fontWeight: 800}}>&gt;</span></div>
      <div style={{fontSize: 72, fontWeight: 720, marginTop: 34, opacity: brand, transform: `translateY(${(1 - brand) * 22}px)`}}>TurboFlux</div>
      <div style={{fontSize: 48, fontWeight: 650, marginTop: 34, opacity: claim, transform: `translateY(${(1 - claim) * 20}px)`}}>从意图，到验证。</div>
      <div style={{fontFamily: BRAND.mono, fontSize: 16, color: BRAND.muted, marginTop: 46, opacity: repo}}>github.com/MengShengbo/TurboFluxCli</div>
      <div style={{position: 'absolute', left: 230, right: 230, bottom: 150, height: 1, background: BRAND.line}}><div style={{height: 1, width: `${line * 100}%`, background: BRAND.ink}} /></div>
    </div>
  );
};
