import {useCurrentFrame, useVideoConfig} from 'remotion';
import {BRAND} from '../design';
import {curves, mix, phase} from '../motion';
import {TerminalStage, TerminalText} from '../components/TerminalStage';

const PermissionPanel = ({selected, confirmed}: {selected: boolean; confirmed: number}) => (
  <div style={{position: 'absolute', left: 28, right: 28, top: 148, padding: '22px 24px', background: BRAND.panelRaised, border: `1px solid ${BRAND.darkLine}`, borderRadius: 6, opacity: 1 - confirmed, transform: `translateY(${-confirmed * 24}px)`, boxShadow: '0 24px 70px rgba(0,0,0,0.54)'}}>
    <div style={{fontFamily: BRAND.mono, fontSize: 14, color: BRAND.warning, marginBottom: 15}}>Approval required</div>
    <div style={{fontFamily: BRAND.mono, fontSize: 13, color: BRAND.textMuted, lineHeight: 1.75}}>
      <div>tool&nbsp;&nbsp;&nbsp; <span style={{color: BRAND.text}}>edit_file</span></div>
      <div>target&nbsp; <span style={{color: BRAND.text}}>src/core/fastContextSubagent.ts</span></div>
      <div>scope&nbsp;&nbsp; <span style={{color: BRAND.text}}>this task</span></div>
    </div>
    <div style={{marginTop: 18, display: 'flex', flexDirection: 'column', gap: 2}}>
      {['Allow once', 'Allow for this task', 'Deny'].map((label, index) => {
        const active = selected && index === 1;
        return (
          <div key={label} style={{height: 46, display: 'grid', gridTemplateColumns: '34px 1fr auto', alignItems: 'center', padding: '0 12px', background: active ? BRAND.warningSoft : 'transparent', borderLeft: `2px solid ${active ? BRAND.warning : 'transparent'}`}}>
            <span style={{fontFamily: BRAND.mono, color: active ? BRAND.warning : BRAND.textMuted}}>{active ? '›' : ''}</span>
            <span style={{fontFamily: BRAND.mono, fontSize: 13, color: active ? BRAND.text : BRAND.textMuted}}>{label}</span>
            {active ? <span style={{fontFamily: BRAND.mono, fontSize: 11, color: BRAND.textMuted}}>Enter</span> : null}
          </div>
        );
      })}
    </div>
  </div>
);

export const ExecutionScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const time = frame / fps;
  const stage = phase(frame, fps, 0.25, 1.2, curves.heroEnter);
  const permission = phase(frame, fps, 4.4, 0.45, curves.heroEnter);
  const selected = time >= 6.2;
  const confirmed = phase(frame, fps, 7.3, 0.55, curves.heroExit);
  const edit = phase(frame, fps, 7.9, 1.3, curves.editorial);
  const progress = mix(42, 78, edit);
  const exit = phase(frame, fps, 12.25, 0.65, curves.heroExit);

  return (
    <div style={{position: 'absolute', inset: 0, background: BRAND.dark, overflow: 'hidden'}}>
      <div style={{position: 'absolute', inset: 0, opacity: 0.34, backgroundImage: 'radial-gradient(circle at 50% 35%, rgba(255,255,255,0.13), transparent 38%), radial-gradient(circle at 15% 70%, rgba(238,90,54,0.12), transparent 26%)'}} />
      <div style={{position: 'absolute', left: 160, right: 160, top: 92, fontSize: 18, color: BRAND.textMuted, opacity: stage}}>一次任务，保持在同一个工作流里。</div>
      <div style={{opacity: stage * (1 - exit), transform: `scale(${0.985 + stage * 0.015 + exit * 0.025})`}}>
        <TerminalStage
          running={confirmed < 0.95 || edit < 0.98}
          workItems={[
            {label: 'FastContext', value: 'READY', tone: 'success'},
            {label: 'read_file', value: 'DONE', tone: 'success'},
            {label: 'edit_file', value: confirmed > 0.8 ? 'RUNNING' : 'REVIEW', tone: confirmed > 0.8 ? 'accent' : 'warning', active: true},
            {label: 'terminal', value: '1 ACTIVE', tone: 'accent'},
          ]}
          taskTitle="修复 FastContext 漏检"
          taskItems={[
            {label: 'trace scheduling', value: 'DONE', tone: 'success'},
            {label: 'patch retrieval', value: confirmed > 0.8 ? 'ACTIVE' : 'WAIT', tone: confirmed > 0.8 ? 'accent' : 'warning', active: true},
            {label: 'run regressions', value: 'QUEUED'},
          ]}
          taskProgress={progress}
          prompt="读透 FastContext 调度链，修复漏检入口文件的问题，并跑完回归测试。"
          promptAttachment="architecture.png"
          statusContext="21.8k/200k"
          statusExtra="cache 18.4k"
          overlay={permission > 0.02 && confirmed < 1 ? <div style={{opacity: permission}}><PermissionPanel selected={selected} confirmed={confirmed} /></div> : null}
        >
          <div style={{display: 'flex', flexDirection: 'column', gap: 17}}>
            <TerminalText tone="success" size={14}>FastContext returned 4 evidence paths</TerminalText>
            <TerminalText size={14}>Root cause: the final coverage pass did not require the subagent execution boundary.</TerminalText>
            <div style={{height: 1, background: BRAND.darkLine}} />
            <TerminalText tone="accent" size={14}>{confirmed > 0.8 ? 'Editing src/core/fastContextSubagent.ts' : 'Prepared a scoped edit'}</TerminalText>
            <div style={{opacity: edit, transform: `translateY(${(1 - edit) * 12}px)`}}><TerminalText tone="success" size={14}>Patch applied · 18 lines changed</TerminalText></div>
          </div>
        </TerminalStage>
      </div>
    </div>
  );
};
