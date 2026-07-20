import {useCurrentFrame, useVideoConfig} from 'remotion';
import {BRAND, WORDMARK} from '../design';
import {curves, phase} from '../motion';

export const EndScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const logo = phase(frame, fps, 0.35, 1.1, curves.heroEnter);
  const claim = phase(frame, fps, 1.55, 0.62, curves.heroEnter);
  const repository = phase(frame, fps, 2.5, 0.48, curves.micro);
  const scan = phase(frame, fps, 0.2, 2.0, curves.camera);

  return (
    <div style={{position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center'}}>
      <div style={{position: 'absolute', left: 160 + scan * 520, right: 160 + scan * 520, top: 180, height: 1, background: BRAND.divider, boxShadow: `0 0 22px ${BRAND.accent}`}} />
      <div style={{height: 164, overflow: 'hidden', opacity: logo}}>
        <pre style={{margin: 0, fontFamily: BRAND.mono, fontSize: 27, lineHeight: 0.96, fontWeight: 850, color: BRAND.foreground, transform: `translateY(${(1 - logo) * 118}px)`, letterSpacing: 0}}>{WORDMARK.join('\n')}</pre>
      </div>
      <div style={{fontSize: 64, fontWeight: 850, marginTop: 28, opacity: claim, transform: `translateY(${(1 - claim) * 34}px)`, letterSpacing: 0}}>从意图，到验证。</div>
      <div style={{fontSize: 20, color: BRAND.muted, marginTop: 22, opacity: claim}}>开源的终端 AI Coding Agent</div>
      <div style={{marginTop: 48, padding: '15px 22px', border: `1px solid ${BRAND.divider}`, background: BRAND.surface, color: BRAND.accent, fontFamily: BRAND.mono, fontSize: 18, opacity: repository, transform: `translateY(${(1 - repository) * 18}px)`}}>github.com/MengShengbo/TurboFluxCli</div>
      <div style={{position: 'absolute', bottom: 78, display: 'flex', gap: 34, color: BRAND.subtle, fontFamily: BRAND.mono, fontSize: 14, opacity: repository}}>
        <span>FastContext</span><span>Model-native reasoning</span><span>Local checkpoints</span><span>MIT License</span>
      </div>
    </div>
  );
};
