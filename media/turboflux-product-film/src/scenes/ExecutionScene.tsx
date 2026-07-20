import {useCurrentFrame, useVideoConfig} from 'remotion';
import {Pointer} from '../engine/Pointer';
import {rectAnchor} from '../engine/geometry';
import {clickPulse, samplePointerPath} from '../engine/pointerPath';
import {BRAND} from '../design';
import {curves, mix, phase} from '../motion';
import {TerminalStage, TerminalText} from '../components/TerminalStage';

const allowRunRect = {x: 438, y: 610, width: 1028, height: 52};

const PermissionCard = ({selected, confirmed}: {selected: boolean; confirmed: number}) => (
  <div style={{position: 'absolute', left: 40, right: 40, top: 210, padding: '18px 20px', background: BRAND.surface, border: `1px solid ${BRAND.warning}`, boxShadow: '0 22px 70px rgba(0,0,0,0.7)', opacity: 1 - confirmed, transform: `translateY(${-confirmed * 28}px)`, fontFamily: BRAND.mono}}>
    <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: 14}}>
      <b style={{fontSize: 18, color: BRAND.warning}}>Permission request</b>
      <span style={{fontSize: 14, color: BRAND.muted}}>REVIEW</span>
    </div>
    <div style={{fontSize: 15, lineHeight: 1.55, color: BRAND.muted}}>
      <div>Tool&nbsp;&nbsp;&nbsp;&nbsp; <b style={{color: BRAND.foreground}}>edit_file</b></div>
      <div>Target&nbsp;&nbsp; <span style={{color: BRAND.accent}}>src/core/session.ts</span></div>
      <div>Reason&nbsp;&nbsp; <span style={{color: BRAND.text}}>Align retry deadline with the upstream timeout.</span></div>
    </div>
    <div style={{marginTop: 16, display: 'flex', flexDirection: 'column', gap: 5}}>
      {[
        ['1. Allow once', 'Approve only this request'],
        ['2. Allow for this run', 'Approve matching actions until this task ends'],
        ['3. Allow for this session', 'Remember matching requests until exit'],
        ['4. Deny', 'Block this request and return to the agent'],
      ].map(([label, description], index) => {
        const active = selected && index === 1;
        return (
          <div key={label} style={{height: 52, display: 'grid', gridTemplateColumns: '320px 1fr', alignItems: 'center', padding: '0 14px', background: active ? BRAND.warningSoft : 'transparent', borderLeft: `3px solid ${active ? BRAND.warning : 'transparent'}`}}>
            <span style={{fontSize: 16, color: active ? BRAND.warning : BRAND.muted, fontWeight: active ? 800 : 500}}>{active ? '› ' : '  '}{label}</span>
            <span style={{fontFamily: BRAND.font, fontSize: 14, color: BRAND.muted}}>{description}</span>
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
  const permission = phase(frame, fps, 2.15, 0.36, curves.heroEnter);
  const selected = time >= 3.95;
  const confirmed = phase(frame, fps, 4.17, 0.46, curves.heroExit);
  const progress = mix(18, 62, phase(frame, fps, 4.35, 1.7, curves.editorial));
  const pointer = samplePointerPath({
    frame,
    fps,
    start: 3.1,
    duration: 1,
    from: {x: 1220, y: 540},
    to: rectAnchor(allowRunRect),
    arc: 0.08,
  });
  const press = clickPulse({frame, fps, at: 4.1});

  return (
    <>
      <TerminalStage
        running
        workItems={[
          {label: 'EXECUTION', value: confirmed > 0.9 ? 'EDITING' : 'WAITING', tone: confirmed > 0.9 ? 'accent' : 'warning', active: true},
          {label: '✓ read_file', value: '0.8s', tone: 'success'},
          {label: 'edit_file', value: confirmed > 0.9 ? 'RUNNING' : 'REVIEW', tone: confirmed > 0.9 ? 'accent' : 'warning', active: true},
          {label: 'Fast context', value: 'COMPLETE', tone: 'success'},
          {label: 'Terminals', value: '1 ACTIVE', tone: 'accent'},
        ]}
        taskTitle="定位登录超时并修复"
        taskItems={[
          {label: 'Steps', value: confirmed > 0.9 ? '2/3' : '1/3', tone: 'success'},
          {label: 'Elapsed', value: `${20 + Math.round(time)}s`, tone: 'accent'},
          {label: 'NOW'},
          {label: confirmed > 0.9 ? 'edit_file session.ts' : 'approval edit_file', active: true},
        ]}
        taskProgress={progress}
        prompt="定位登录超时，修复并验证"
        statusContext="18.6k/200k"
        overlay={permission > 0.02 && confirmed < 1 ? <div style={{opacity: permission}}><PermissionCard selected={selected} confirmed={confirmed} /></div> : null}
      >
        <div style={{display: 'flex', flexDirection: 'column', gap: 14}}>
          <TerminalText tone="success">✓ Root cause: retry window outlives upstream deadline</TerminalText>
          <TerminalText><span style={{color: BRAND.muted}}>Plan</span>&nbsp; 1. align deadline&nbsp;&nbsp; 2. preserve cancellation&nbsp;&nbsp; 3. run regressions</TerminalText>
          <div style={{height: 1, background: BRAND.dividerSoft, margin: '4px 0'}} />
          <TerminalText tone="accent">● Preparing edit src/core/session.ts</TerminalText>
        </div>
      </TerminalStage>
      {time >= 2.9 && time <= 4.55 ? <Pointer x={pointer.x} y={pointer.y} press={press} /> : null}
    </>
  );
};
