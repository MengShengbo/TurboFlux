import {useCurrentFrame, useVideoConfig} from 'remotion';
import {BRAND} from '../design';
import {curves, phase, stagger} from '../motion';
import {TerminalStage, TerminalText} from '../components/TerminalStage';

const diffLines = [
  {kind: 'same', text: ' const timeout = resolveUpstreamTimeout(config)'},
  {kind: 'remove', text: '-const retryUntil = Date.now() + retryWindow'},
  {kind: 'add', text: '+const retryUntil = Math.min('},
  {kind: 'add', text: '+  Date.now() + retryWindow,'},
  {kind: 'add', text: '+  requestDeadline - SAFETY_MARGIN_MS,'},
  {kind: 'add', text: '+)'},
  {kind: 'same', text: ' return retryWithCancellation(task, retryUntil)'},
];

export const VerificationScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const time = frame / fps;
  const diff = phase(frame, fps, 0.45, 0.48, curves.heroEnter);
  const typecheck = phase(frame, fps, 2.6, 1.08, curves.editorial);
  const tests = phase(frame, fps, 4.0, 2.36, curves.editorial);
  const complete = phase(frame, fps, 6.4, 0.42, curves.micro);
  const cameraIn = phase(frame, fps, 0, 0.9, curves.camera);
  const cameraTravel = phase(frame, fps, 2.1, 3.6, curves.camera);

  return (
    <TerminalStage
      running={complete < 0.98}
      scale={1 + cameraIn * 0.04}
      translateX={cameraIn * -32 + cameraTravel * 66}
      workItems={[
        {label: 'EXECUTION', value: complete > 0.5 ? 'COMPLETE' : 'VERIFYING', tone: complete > 0.5 ? 'success' : 'accent', active: complete < 0.5},
        {label: '✓ edit_file', value: 'session.ts', tone: 'success'},
        {label: typecheck > 0.98 ? '✓ type-check' : '● type-check', value: typecheck > 0.98 ? 'PASS' : 'RUNNING', tone: typecheck > 0.98 ? 'success' : 'accent'},
        {label: tests > 0.98 ? '✓ tests' : '● tests', value: tests > 0.98 ? 'PASS' : tests > 0.02 ? 'RUNNING' : 'QUEUED', tone: tests > 0.98 ? 'success' : 'accent'},
        {label: 'Terminals', value: '1 ACTIVE', tone: 'accent'},
      ]}
      taskTitle="定位登录超时并修复"
      taskItems={[
        {label: 'Steps', value: complete > 0.5 ? '3/3' : '2/3', tone: 'success'},
        {label: 'Elapsed', value: `${29 + Math.round(time)}s`, tone: 'accent'},
        {label: 'NOW'},
        {label: complete > 0.5 ? 'verification complete' : tests > 0.02 ? 'npm test' : 'npm run type-check', active: true},
      ]}
      taskProgress={complete > 0.5 ? 100 : 62 + tests * 34}
      prompt="定位登录超时，修复并验证"
      statusContext="25.8k/200k"
      statusExtra="out 1.2k  cache 11.4k"
    >
      <div style={{display: 'grid', gridTemplateColumns: '1.08fr 0.92fr', gap: 18, height: '100%'}}>
        <div style={{opacity: diff, transform: `translateX(${(1 - diff) * -40}px)`, minWidth: 0}}>
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12}}>
            <TerminalText tone="accent" bold>~ src/core/session.ts</TerminalText>
            <span style={{fontFamily: BRAND.mono, fontSize: 14}}><span style={{color: BRAND.success}}>+4</span>&nbsp; <span style={{color: BRAND.danger}}>-1</span></span>
          </div>
          <div style={{background: BRAND.surface, border: `1px solid ${BRAND.dividerSoft}`, padding: '12px 0'}}>
            {diffLines.map((line, index) => {
              const show = stagger(frame, fps, index, 0.78, 0.14, 0.28);
              const background = line.kind === 'add' ? '#102518' : line.kind === 'remove' ? '#251313' : 'transparent';
              const color = line.kind === 'add' ? BRAND.success : line.kind === 'remove' ? BRAND.danger : BRAND.muted;
              return (
                <div key={`${line.kind}-${index}`} style={{height: 34, display: 'flex', alignItems: 'center', padding: '0 14px', background, color, fontFamily: BRAND.mono, fontSize: 15, opacity: show, transform: `translateX(${(1 - show) * 22}px)`, whiteSpace: 'pre'}}>{line.text}</div>
              );
            })}
          </div>
        </div>

        <div style={{display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 2}}>
          <div style={{fontFamily: BRAND.mono, fontSize: 15, color: BRAND.muted}}>BACKGROUND TERMINAL · verify</div>
          <div style={{background: BRAND.surface, border: `1px solid ${BRAND.dividerSoft}`, padding: '16px 18px', flex: 1, display: 'flex', flexDirection: 'column', gap: 12}}>
            <TerminalText><span style={{color: BRAND.accent}}>$</span>&nbsp; npm run type-check</TerminalText>
            <div style={{opacity: typecheck, transform: `translateY(${(1 - typecheck) * 8}px)`}}><TerminalText tone="success">✓ TypeScript · no errors</TerminalText></div>
            <div style={{height: 1, background: BRAND.dividerSoft}} />
            <div style={{opacity: phase(frame, fps, 3.92, 0.2, curves.micro)}}><TerminalText><span style={{color: BRAND.accent}}>$</span>&nbsp; npm test</TerminalText></div>
            <div style={{opacity: tests, transform: `translateY(${(1 - tests) * 12}px)`, display: 'flex', flexDirection: 'column', gap: 8}}>
              <TerminalText><span style={{color: BRAND.muted}}>RUN</span>&nbsp; vitest</TerminalText>
              <TerminalText tone="success">Test Files&nbsp; 57 passed (57)</TerminalText>
              <TerminalText tone="success">Tests&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 493 passed (493)</TerminalText>
            </div>
            <div style={{marginTop: 'auto', opacity: complete, transform: `translateY(${(1 - complete) * 18}px)`, padding: '13px 14px', background: BRAND.successSoft, borderLeft: `3px solid ${BRAND.success}`}}>
              <TerminalText tone="success" bold>✓ Change verified</TerminalText>
            </div>
          </div>
        </div>
      </div>
    </TerminalStage>
  );
};
