import {useCurrentFrame, useVideoConfig} from 'remotion';
import {BRAND} from '../design';
import {curves, phase, stagger} from '../motion';
import {ProgressLine, TerminalStage, TerminalText} from '../components/TerminalStage';

const evidence = [
  {path: 'src/auth/sessionService.ts', line: '184–231', score: '0.96', detail: 'refresh deadline and retry boundary'},
  {path: 'src/api/authController.ts', line: '88–117', score: '0.91', detail: 'request timeout enters session service'},
  {path: 'src/core/retryPolicy.ts', line: '42–79', score: '0.87', detail: 'backoff ignores upstream deadline'},
];

export const FastContextScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const time = frame / fps;
  const scan = phase(frame, fps, 0.5, 5.2, curves.editorial);
  const complete = phase(frame, fps, 5.7, 0.4, curves.micro);
  const files = Math.round(scan * 38);
  const hits = Math.round(scan * 11);

  return (
    <TerminalStage
      running={complete < 0.95}
      workItems={[
        {label: 'EXECUTION', value: 'READING', tone: 'accent', active: true},
        {label: 'Fast context', value: complete > 0.5 ? 'COMPLETE' : 'SCANNING', tone: complete > 0.5 ? 'success' : 'accent', active: complete < 0.5},
        {label: 'Evidence', value: `${files} files / ${hits} hits`, tone: 'accent'},
        {label: 'Main agent', value: 'ACTIVE', tone: 'success'},
        {label: 'Terminals', value: 'NONE'},
      ]}
      taskTitle="定位登录超时并修复"
      taskItems={[
        {label: 'Phase', value: complete > 0.4 ? 'ROOT CAUSE' : 'PLANNING', tone: complete > 0.4 ? 'success' : 'accent'},
        {label: 'Elapsed', value: `${Math.max(1, Math.round(time))}s`, tone: 'accent'},
        {label: 'NOW'},
        {label: complete > 0.4 ? 'read_file sessionService.ts' : 'explore_code auth timeout', active: true},
      ]}
      taskProgress={complete > 0.5 ? 28 : 12 + scan * 12}
      prompt="定位登录超时，修复并验证"
      statusContext="12.3k/200k"
    >
      <div style={{display: 'flex', flexDirection: 'column', gap: 14}}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline'}}>
          <div>
            <TerminalText tone="accent" bold>FastContext / background retrieval</TerminalText>
            <div style={{fontFamily: BRAND.mono, fontSize: 14, color: BRAND.muted, marginTop: 4}}>main agent remains available while evidence is ranked</div>
          </div>
          <div style={{fontFamily: BRAND.mono, fontSize: 15, color: complete > 0.5 ? BRAND.success : BRAND.accent}}>{complete > 0.5 ? 'RANKED' : `WAVE ${Math.min(3, 1 + Math.floor(scan * 3))}/3`}</div>
        </div>
        <ProgressLine value={complete > 0.5 ? 100 : scan * 92} tone={complete > 0.5 ? 'success' : 'accent'} />
        <div style={{display: 'flex', flexDirection: 'column', gap: 9, marginTop: 8}}>
          {evidence.map((item, index) => {
            const show = stagger(frame, fps, index, 1.1, 0.9, 0.42);
            return (
              <div key={item.path} style={{opacity: show, transform: `translateX(${(1 - show) * 46}px)`, display: 'grid', gridTemplateColumns: '42px minmax(0, 1fr) 70px', gap: 12, padding: '12px 14px', background: index === 0 && complete > 0.4 ? '#0d191d' : BRAND.surface, borderLeft: `3px solid ${index === 0 ? BRAND.accent : BRAND.divider}`}}>
                <span style={{fontFamily: BRAND.mono, fontSize: 16, color: index === 0 ? BRAND.accent : BRAND.muted}}>0{index + 1}</span>
                <div style={{minWidth: 0}}>
                  <div style={{fontFamily: BRAND.mono, fontSize: 17, color: BRAND.foreground, fontWeight: 700}}>{item.path}<span style={{color: BRAND.muted}}>:{item.line}</span></div>
                  <div style={{fontFamily: BRAND.font, fontSize: 14, color: BRAND.muted, marginTop: 4}}>{item.detail}</div>
                </div>
                <span style={{fontFamily: BRAND.mono, fontSize: 16, color: BRAND.success, textAlign: 'right'}}>{item.score}</span>
              </div>
            );
          })}
        </div>
        <div style={{opacity: phase(frame, fps, 3.7, 0.5, curves.heroEnter), marginTop: 8, borderTop: `1px solid ${BRAND.dividerSoft}`, paddingTop: 14}}>
          <TerminalText><span style={{color: BRAND.muted}}>Main Agent</span>&nbsp; 已锁定超时传播链，继续读取重试边界。</TerminalText>
        </div>
      </div>
    </TerminalStage>
  );
};
