import {useCurrentFrame, useVideoConfig} from 'remotion';
import {BRAND} from '../design';
import {curves, phase, stagger} from '../motion';

const diffLines = [
  [' ', 'const requiredLayers = collectRequiredLayers(query)'],
  ['-', 'if (candidates.length >= targetCount) return candidates'],
  ['+', 'const coverage = verifyRequiredLayers(candidates, requiredLayers)'],
  ['+', 'if (!coverage.complete) candidates.push(...coverage.missing)'],
  ['+', 'return rankEvidence(candidates, query)'],
];

export const VerificationScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const diff = phase(frame, fps, 0.35, 0.85, curves.heroEnter);
  const camera = phase(frame, fps, 4.4, 1.8, curves.camera);
  const typecheck = phase(frame, fps, 5.4, 0.7, curves.heroEnter);
  const tests = phase(frame, fps, 7.25, 1.2, curves.editorial);
  const verified = phase(frame, fps, 9.45, 0.55, curves.heroEnter);
  const exit = phase(frame, fps, 11.25, 0.65, curves.heroExit);

  return (
    <div style={{position: 'absolute', inset: 0, background: BRAND.dark, color: BRAND.text, opacity: 1 - exit}}>
      <div style={{position: 'absolute', left: 150, top: 95, fontSize: 48, fontWeight: 680}}>修改不是终点。验证才是。</div>
      <div style={{position: 'absolute', left: 150, top: 210, width: 1620, height: 690, overflow: 'hidden'}}>
        <div style={{display: 'flex', width: 2760, height: '100%', transform: `translateX(${-camera * 1500}px)`}}>
          <div style={{width: 1500, paddingRight: 120, boxSizing: 'border-box', opacity: diff}}>
            <div style={{display: 'flex', justifyContent: 'space-between', fontFamily: BRAND.mono, fontSize: 15, color: BRAND.textMuted, marginBottom: 22}}>
              <span>src/core/fastContextSubagent.ts</span><span style={{color: BRAND.success}}>+4&nbsp;&nbsp;<span style={{color: BRAND.danger}}>-1</span></span>
            </div>
            <div style={{borderTop: `1px solid ${BRAND.darkLine}`}}>
              {diffLines.map(([kind, line], index) => {
                const show = stagger(frame, fps, index, 1.15, 0.36, 0.5);
                const color = kind === '+' ? BRAND.success : kind === '-' ? BRAND.danger : BRAND.textMuted;
                const background = kind === '+' ? BRAND.successSoft : kind === '-' ? '#261513' : 'transparent';
                return <div key={`${kind}-${line}`} style={{height: 78, display: 'grid', gridTemplateColumns: '52px 1fr', alignItems: 'center', padding: '0 20px', boxSizing: 'border-box', borderBottom: `1px solid ${BRAND.darkLine}`, background, opacity: show, transform: `translateX(${(1 - show) * 24}px)`, fontFamily: BRAND.mono, fontSize: 17, color}}><span>{kind}</span><span>{line}</span></div>;
              })}
            </div>
          </div>
          <div style={{width: 1260, padding: '28px 60px 0 60px', boxSizing: 'border-box'}}>
            <div style={{fontFamily: BRAND.mono, fontSize: 16, color: BRAND.textMuted, marginBottom: 36}}>background terminal / verify</div>
            <div style={{fontFamily: BRAND.mono, fontSize: 20, lineHeight: 2.1}}>
              <div><span style={{color: BRAND.accent}}>$</span> npm run typecheck</div>
              <div style={{opacity: typecheck, color: BRAND.success}}>TypeScript · no errors</div>
              <div style={{height: 1, background: BRAND.darkLine, margin: '28px 0'}} />
              <div style={{opacity: typecheck}}><span style={{color: BRAND.accent}}>$</span> npm test -- fastContext</div>
              <div style={{opacity: tests, transform: `translateY(${(1 - tests) * 16}px)`}}>
                <div style={{color: BRAND.success}}>Test Files&nbsp; 57 passed</div>
                <div style={{color: BRAND.success}}>Tests&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 493 passed</div>
              </div>
            </div>
            <div style={{marginTop: 54, height: 62, display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: `1px solid ${BRAND.success}`, opacity: verified}}>
              <span style={{fontSize: 25, fontWeight: 650}}>Change verified</span><span style={{fontFamily: BRAND.mono, color: BRAND.success}}>ready</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
