import {useCurrentFrame, useVideoConfig} from 'remotion';
import {BRAND} from '../design';
import {curves, phase, reveal} from '../motion';

const prompt = '读透 FastContext 调度链，修复漏检入口文件的问题，并跑完回归测试。';

export const IntentScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const surface = phase(frame, fps, 0.35, 0.9, curves.heroEnter);
  const attachment = phase(frame, fps, 1.3, 0.35, curves.micro);
  const typing = phase(frame, fps, 2.0, 5.0, curves.editorial);
  const metadata = phase(frame, fps, 6.2, 0.6, curves.heroEnter);
  const submit = phase(frame, fps, 8.45, 0.18, curves.micro);
  const processing = phase(frame, fps, 8.66, 0.55, curves.heroEnter);
  const crop = phase(frame, fps, 9.8, 2.6, curves.camera);
  const exit = phase(frame, fps, 12.35, 0.55, curves.heroExit);

  return (
    <div style={{position: 'absolute', inset: 0, background: BRAND.paperBright, opacity: 1 - exit}}>
      <div style={{position: 'absolute', left: 160 - crop * 110, right: 160 - crop * 110, top: 290 + crop * 124, opacity: surface, transform: `scale(${1 + crop * 0.1})`, transformOrigin: 'center bottom'}}>
        <div style={{height: 290, borderTop: `1px solid ${BRAND.line}`, borderBottom: `1px solid ${BRAND.line}`, padding: '42px 52px 34px', boxSizing: 'border-box', background: BRAND.paperBright}}>
          <div style={{height: 128, fontSize: 28, lineHeight: 1.55, color: BRAND.ink, display: 'flex', alignItems: 'flex-start'}}>
            <span style={{fontFamily: BRAND.mono, color: BRAND.accent, marginRight: 20}}>&gt;</span>
            <span>{reveal(prompt, typing)}<span style={{display: 'inline-block', width: 2, height: 30, background: BRAND.ink, marginLeft: 4, opacity: typing < 1 ? 0.8 : 0}} /></span>
          </div>
          <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 18}}>
            <div style={{display: 'flex', alignItems: 'center', gap: 26}}>
              <span style={{fontFamily: BRAND.mono, fontSize: 15, color: BRAND.inkSoft, opacity: attachment, borderBottom: `1px solid ${BRAND.accent}`, paddingBottom: 4}}>[architecture.png]</span>
              <span style={{fontFamily: BRAND.mono, fontSize: 14, color: BRAND.muted, opacity: metadata}}>claude-sonnet-5</span>
              <span style={{fontFamily: BRAND.mono, fontSize: 14, color: BRAND.muted, opacity: metadata}}>effort high</span>
              <span style={{fontFamily: BRAND.mono, fontSize: 14, color: BRAND.muted, opacity: metadata}}>approval agent</span>
            </div>
            <div style={{width: 54, height: 54, borderRadius: 28, display: 'grid', placeItems: 'center', background: submit > 0.5 ? BRAND.accent : BRAND.ink, color: 'white', fontSize: 24, transform: `scale(${1 - submit * 0.08})`}}>↑</div>
          </div>
        </div>
        <div style={{height: 2, marginTop: 26, background: BRAND.line, overflow: 'hidden', opacity: processing}}>
          <div style={{height: 2, width: `${22 + processing * 78}%`, background: BRAND.accent, transform: `translateX(${processing * 340}px)`}} />
        </div>
        <div style={{fontFamily: BRAND.mono, fontSize: 13, color: BRAND.muted, marginTop: 15, opacity: processing}}>FastContext started in background · main agent remains available</div>
      </div>
    </div>
  );
};
