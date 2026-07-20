import {useCurrentFrame, useVideoConfig} from 'remotion';
import {BRAND} from '../design';
import {curves, phase} from '../motion';

export const ModelScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const model = phase(frame, fps, 0.4, 0.75, curves.heroEnter);
  const effort = phase(frame, fps, 2.05, 0.75, curves.heroEnter);
  const select = phase(frame, fps, 3.5, 0.35, curves.micro);
  const exit = phase(frame, fps, 5.35, 0.55, curves.heroExit);

  return (
    <div style={{position: 'absolute', inset: 0, background: BRAND.paperBright, opacity: 1 - exit}}>
      <div style={{position: 'absolute', left: 210, top: 165, fontSize: 58, fontWeight: 690}}>连接你的模型。使用它原生的推理能力。</div>
      <div style={{position: 'absolute', left: 210, right: 210, top: 340, borderTop: `1px solid ${BRAND.line}`}}>
        <div style={{height: 126, display: 'grid', gridTemplateColumns: '260px 1fr 280px', alignItems: 'center', borderBottom: `1px solid ${BRAND.line}`, opacity: model, transform: `translateY(${(1 - model) * 20}px)`}}>
          <span style={{fontFamily: BRAND.mono, fontSize: 23}}>/model</span>
          <span style={{fontSize: 26}}>claude-sonnet-5</span>
          <span style={{fontFamily: BRAND.mono, fontSize: 14, color: BRAND.muted, textAlign: 'right'}}>discovered from current API</span>
        </div>
        <div style={{height: 126, display: 'grid', gridTemplateColumns: '260px 1fr 280px', alignItems: 'center', borderBottom: `1px solid ${BRAND.line}`, opacity: effort, transform: `translateY(${(1 - effort) * 20}px)`}}>
          <span style={{fontFamily: BRAND.mono, fontSize: 23}}>/effort</span>
          <div style={{display: 'flex', gap: 30, alignItems: 'center'}}>
            {['low', 'medium', 'high', 'max'].map((item) => <span key={item} style={{fontFamily: BRAND.mono, fontSize: 18, color: item === 'high' ? BRAND.ink : BRAND.muted, paddingBottom: 8, borderBottom: `2px solid ${item === 'high' ? BRAND.accent : 'transparent'}`, transform: item === 'high' ? `translateY(${-select * 3}px)` : undefined}}>{item}</span>)}
          </div>
          <span style={{fontFamily: BRAND.mono, fontSize: 14, color: BRAND.muted, textAlign: 'right'}}>model-native</span>
        </div>
      </div>
    </div>
  );
};
