import {useCurrentFrame, useVideoConfig} from 'remotion';
import {Pointer} from '../engine/Pointer';
import {rectAnchor} from '../engine/geometry';
import {clickPulse, samplePointerPath} from '../engine/pointerPath';
import {BRAND} from '../design';
import {phase, reveal, curves} from '../motion';
import {TerminalStage, TerminalText} from '../components/TerminalStage';

const promptText = '定位登录超时，修复并验证';
const submitRect = {x: 1774, y: 906, width: 48, height: 48};

export const IntentScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const time = frame / fps;
  const attachment = phase(frame, fps, 0.9, 0.34, curves.micro);
  const typing = phase(frame, fps, 1.65, 2.05, curves.editorial);
  const submitted = phase(frame, fps, 5.38, 0.18, curves.micro);
  const pointer = samplePointerPath({
    frame,
    fps,
    start: 4.35,
    duration: 1,
    from: {x: 1420, y: 760},
    to: rectAnchor(submitRect),
    arc: -0.1,
  });
  const press = clickPulse({frame, fps, at: 5.35});

  return (
    <>
      <TerminalStage
        animateIn
        running={submitted > 0.08}
        workItems={submitted > 0.1 ? [
          {label: 'EXECUTION', value: 'STARTING', tone: 'accent', active: true},
          {label: 'Fast context', value: 'QUEUED', tone: 'accent'},
          {label: 'Terminals', value: 'NONE'},
        ] : [
          {label: 'EXECUTION', value: 'READY'},
          {label: 'Fast context', value: 'READY', tone: 'success'},
          {label: 'Terminals', value: 'NONE'},
        ]}
        promptAttachment={attachment > 0.06 ? '[Image #1]' : undefined}
        prompt={<span>{reveal(promptText, typing)}<span style={{opacity: Math.sin(time * Math.PI * 3) > 0 ? 1 : 0, color: BRAND.foreground}}>▋</span></span>}
        statusContext="0/200k"
      >
        <div style={{height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 70px'}}>
          <div style={{fontFamily: BRAND.font, fontSize: 46, lineHeight: 1.18, fontWeight: 800, color: BRAND.foreground}}>截图、日志、目标，<br />直接进入任务。</div>
          <div style={{marginTop: 28, opacity: submitted}}>
            <TerminalText tone="accent">● Objective accepted · preparing retrieval</TerminalText>
          </div>
        </div>
      </TerminalStage>
      {time >= 4.15 && time <= 5.78 ? <Pointer x={pointer.x} y={pointer.y} press={press} /> : null}
    </>
  );
};
