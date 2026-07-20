import {useCurrentFrame, useVideoConfig} from 'remotion';
import {BRAND} from '../design';
import {curves, phase, stagger} from '../motion';

const evidence = [
  ['01', 'src/core/fastContextSubagent.ts', 'subagent orchestration'],
  ['02', 'src/core/agentEngine.ts', 'main-agent scheduling'],
  ['03', 'src/core/fastContextTypes.ts', 'retrieval contract'],
  ['04', 'src/cli/components/layout/fastContextUi.ts', 'visible progress state'],
];

export const FastContextScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const claim = phase(frame, fps, 0.15, 0.8, curves.heroEnter);
  const claimOut = phase(frame, fps, 2.75, 0.5, curves.heroExit);
  const darkRise = phase(frame, fps, 2.55, 1.15, curves.camera);
  const baseline = phase(frame, fps, 3.35, 1.1, curves.camera);
  const result = phase(frame, fps, 7.2, 0.55, curves.heroEnter);

  return (
    <div style={{position: 'absolute', inset: 0, background: BRAND.paperBright, overflow: 'hidden'}}>
      <div style={{position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', opacity: claim * (1 - claimOut), transform: `translateY(${-claimOut * 30}px)`}}>
        <div style={{fontSize: 70, fontWeight: 700, letterSpacing: 0}}>先读懂代码库。再开始修改。</div>
      </div>
      <div style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: `${darkRise * 100}%`, background: BRAND.dark, color: BRAND.text, overflow: 'hidden'}}>
        <div style={{position: 'absolute', left: 146, right: 146, top: 122}}>
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 58}}>
            <div style={{fontSize: 26, fontWeight: 650}}>FastContext</div>
            <div style={{fontFamily: BRAND.mono, fontSize: 13, color: BRAND.textMuted}}>background subagent · medium</div>
          </div>
          <div style={{height: 1, background: BRAND.darkLine, width: `${baseline * 100}%`}} />
          <div style={{marginTop: 6}}>
            {evidence.map(([rank, path, role], index) => {
              const show = stagger(frame, fps, index, 4.0, 0.68, 0.55);
              return (
                <div key={path} style={{height: 105, display: 'grid', gridTemplateColumns: '82px 1fr 300px', alignItems: 'center', borderBottom: `1px solid ${BRAND.darkLine}`, opacity: show, transform: `translateY(${(1 - show) * 22}px)`}}>
                  <span style={{fontFamily: BRAND.mono, fontSize: 15, color: index === 0 ? BRAND.accent : BRAND.textMuted}}>{rank}</span>
                  <span style={{fontFamily: BRAND.mono, fontSize: 21, color: BRAND.text}}>{path}</span>
                  <span style={{fontFamily: BRAND.mono, fontSize: 13, color: BRAND.textMuted, textAlign: 'right'}}>{role}</span>
                </div>
              );
            })}
          </div>
          <div style={{display: 'flex', justifyContent: 'space-between', marginTop: 30, fontFamily: BRAND.mono, fontSize: 13, opacity: result}}>
            <span style={{color: BRAND.success}}>evidence ready</span>
            <span style={{color: BRAND.textMuted}}>main agent continued planning during retrieval</span>
          </div>
        </div>
      </div>
    </div>
  );
};
