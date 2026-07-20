import {useCurrentFrame, useVideoConfig} from 'remotion';
import {BRAND} from '../design';
import {curves, mix, phase} from '../motion';

const history = [
  'User · Compare FastContext with the retrieval baseline.',
  'Agent · Traced the scheduler, subagent boundary, types and UI state.',
  'Tool · Read src/core/fastContextSubagent.ts',
  'Decision · Require layer coverage before ranking evidence.',
  'Tool · Applied scoped edit and ran regressions.',
];

export const ContinuityScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const gather = phase(frame, fps, 0.55, 2.3, curves.camera);
  const compact = phase(frame, fps, 3.0, 1.35, curves.editorial);
  const resume = phase(frame, fps, 5.25, 0.7, curves.heroEnter);
  const restored = phase(frame, fps, 6.4, 0.7, curves.heroEnter);
  const context = mix(84.7, 31.2, compact).toFixed(1);
  const exit = phase(frame, fps, 8.2, 0.65, curves.heroExit);

  return (
    <div style={{position: 'absolute', inset: 0, background: BRAND.dark, color: BRAND.text, opacity: 1 - exit}}>
      <div style={{position: 'absolute', left: 150, right: 150, top: 90, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline'}}>
        <div style={{fontSize: 50, fontWeight: 680}}>长会话，不该重新开始。</div>
        <div style={{fontFamily: BRAND.mono, color: BRAND.textMuted}}>{context}k / 200k</div>
      </div>
      <div style={{position: 'absolute', left: 210, right: 210, top: 240, height: 560}}>
        {history.map((line, index) => {
          const baseY = index * 84;
          const targetY = 30 + index * 21;
          const y = mix(baseY, targetY, compact);
          return (
            <div key={line} style={{position: 'absolute', left: 0, right: 0, top: y, height: mix(62, 18, compact), display: 'flex', alignItems: 'center', padding: `0 ${mix(18, 0, compact)}px`, borderBottom: `1px solid ${BRAND.darkLine}`, fontFamily: BRAND.mono, fontSize: mix(15, 10, compact), color: BRAND.textMuted, opacity: (0.5 + gather * 0.5) * (1 - compact * 0.55), overflow: 'hidden'}}>{line}</div>
          );
        })}
        <div style={{position: 'absolute', left: 0, right: 0, top: 174, minHeight: 170, padding: '28px 32px', boxSizing: 'border-box', borderTop: `1px solid ${BRAND.accent}`, borderBottom: `1px solid ${BRAND.darkLine}`, opacity: compact, transform: `translateY(${(1 - compact) * 28}px)`}}>
          <div style={{fontFamily: BRAND.mono, fontSize: 13, color: BRAND.accent}}>recap</div>
          <div style={{fontSize: 22, lineHeight: 1.55, marginTop: 16}}>已定位 FastContext 调度链，补全关键层级覆盖检查；改动通过类型检查与 493 项测试。</div>
          <div style={{fontFamily: BRAND.mono, fontSize: 12, color: BRAND.textMuted, marginTop: 18}}>active files · fastContextSubagent.ts · agentEngine.ts · fastContextTypes.ts</div>
        </div>
        <div style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: 72, display: 'flex', alignItems: 'center', padding: '0 24px', boxSizing: 'border-box', background: BRAND.panel, border: `1px solid ${BRAND.darkLine}`, opacity: resume}}>
          <span style={{fontFamily: BRAND.mono, fontSize: 18, color: BRAND.accent, marginRight: 20}}>&gt;</span>
          <span style={{fontFamily: BRAND.mono, fontSize: 18}}>/resume fastcontext-fix</span>
          <span style={{marginLeft: 'auto', fontFamily: BRAND.mono, fontSize: 13, color: BRAND.success, opacity: restored}}>task, files and decisions restored</span>
        </div>
      </div>
    </div>
  );
};
