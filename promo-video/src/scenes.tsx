import React from 'react';
import {AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {Badge, BrandMark, Dashboard, DropIn, GridBackground, SceneLabel, Vignette, WindowFrame} from './components';
import {C, clamp, ease, linear, mono} from './theme';

export const IntroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const command = 'turboflux "审计认证流程，并交付可审查补丁"';
  const typed = Math.min(command.length, Math.max(0, Math.floor((frame - 18) / 1.45)));
  const enter = 96;
  const pushEnd = 102;
  const cut = frame >= pushEnd;
  const push = interpolate(frame, [enter, pushEnd], [1, 3.4], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.in(Easing.cubic),
  });
  const blur = interpolate(frame, [pushEnd - 3, pushEnd], [0, 12], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const dashScale = interpolate(frame, [pushEnd, pushEnd + 8], [1.07, 1], {extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)});
  return <AbsoluteFill style={{background: C.bg, overflow: 'hidden'}}>
    <GridBackground opacity={.22} />
    {!cut ? <div style={{position: 'absolute', inset: 0, transform: `scale(${push})`, transformOrigin: '960px 620px', filter: blur ? `blur(${blur}px)` : undefined}}>
      <WindowFrame title="local shell · ~/studio/aurora" style={{position: 'absolute', left: 340, top: 180, width: 1240, height: 650}}>
        <div style={{padding: '34px 50px', fontFamily: mono}}>
          <pre style={{margin: 0, color: C.cyan, fontFamily: mono, fontSize: 17, lineHeight: 1.12, fontWeight: 800, textShadow: `0 0 16px ${C.cyan}55`}}>{`  ______           __          ________         
 /_  __/_  _______/ /_  ____  / ____/ /_  ___  __
  / / / / / / ___/ __ \\/ __ \\/ /_  / / / / / |/_/
 / / / /_/ / /  / /_/ / /_/ / __/ / /_/ />  <  
/_/  \\__,_/_/  /_.___/\\____/_/ /_/\\__,_/_/|_|  `}</pre>
          <div style={{color: C.green, fontSize: 14, marginTop: 8}}>v0.1.5 · workspace: ~/studio/aurora</div>
          <div style={{color: C.dim, fontSize: 22}}>~/studio/aurora <span style={{color: C.info}}>git:(feature/auth-proof)</span></div>
          <div style={{display: 'flex', alignItems: 'center', marginTop: 24, fontSize: 32, color: C.white, whiteSpace: 'pre'}}>
            <span style={{color: C.green, marginRight: 16}}>❯</span>
            <span>{command.substring(0, typed)}</span>
            <span style={{width: 18, height: 38, marginLeft: 5, background: C.cyan, opacity: frame % 12 < 6 ? 1 : 0, boxShadow: `0 0 18px ${C.cyan}99`}} />
          </div>
          <div style={{marginTop: 34, color: C.dim, fontSize: 16, letterSpacing: 2}}>LOCAL-FIRST · PERMISSION-AWARE · EVIDENCE-DRIVEN</div>
        </div>
      </WindowFrame>
      <div style={{position: 'absolute', left: 0, right: 0, bottom: 82, textAlign: 'center', fontFamily: mono, color: C.muted, fontSize: 32, letterSpacing: 3, opacity: ease(frame, 34, 54)}}>一句指令。整个工程开始流动。</div>
    </div> : <div style={{position: 'absolute', left: 110, top: 85, width: 1700, height: 910, transform: `scale(${dashScale})`}}>
      <WindowFrame style={{width: '100%', height: '100%'}}><Dashboard frame={frame - pushEnd + 34} dense /></WindowFrame>
    </div>}
    <Vignette />
  </AbsoluteFill>;
};

export const WorkbenchScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const borderP = ease(frame, 0, 20);
  const border = 26 * borderP;
  const drop = spring({frame: frame - 8, fps, config: {damping: 18, stiffness: 105, mass: 1}});
  const titleP = ease(frame, 68, 86);
  return <AbsoluteFill style={{background: C.bg, overflow: 'hidden'}}>
    <GridBackground opacity={.12} />
    <div style={{position: 'absolute', inset: border, borderRadius: 12, overflow: 'hidden'}}>
      <div style={{position: 'absolute', left: 120, top: 86, width: 1680, height: 850, opacity: drop, transform: `translateY(${340 * (1 - drop)}px) scale(${.88 + .12 * drop})`}}>
        <WindowFrame right={<Badge color={C.green}>WORKSPACE READY</Badge>} style={{height: '100%'}}><Dashboard frame={frame + 42} /></WindowFrame>
      </div>
      <div style={{position: 'absolute', left: 170, bottom: 82, opacity: titleP, transform: `translateY(${24 * (1 - titleP)}px)`, padding: '18px 24px', background: 'rgba(5,5,5,.82)', borderLeft: `3px solid ${C.cyan}`}}>
        <div style={{fontFamily: mono, color: C.white, fontSize: 56, fontWeight: 800}}>本地工作台，不只是聊天窗口。</div>
        <div style={{fontFamily: mono, color: C.muted, fontSize: 32, marginTop: 12}}>模型、上下文、队列、终端与恢复状态，同一处持续运行。</div>
      </div>
    </div>
    {[
      {left: 0, top: 0, right: 0, height: border}, {left: 0, bottom: 0, right: 0, height: border},
      {left: 0, top: 0, bottom: 0, width: border}, {right: 0, top: 0, bottom: 0, width: border},
    ].map((style, index) => <div key={index} style={{position: 'absolute', background: C.cyan, boxShadow: `0 0 28px ${C.cyan}55`, ...style}} />)}
    <div style={{position: 'absolute', top: 2, left: 72, height: border, display: 'flex', alignItems: 'center', fontFamily: mono, fontWeight: 800, color: C.bg, letterSpacing: 2, opacity: borderP}}>TURBOFLUX / VIBE</div>
  </AbsoluteFill>;
};

const evidence = [
  {stage: 'MAP', count: '184 FILES', path: 'src/auth/** · src/api/**', note: '建立隔离索引', color: C.info},
  {stage: 'READ', count: '36 CANDIDATES', path: 'session.ts · token.ts · guard.ts', note: '读取关键上下文', color: C.cyan},
  {stage: 'RANK', count: '12 EVIDENCE', path: 'refreshToken() · requireScope()', note: '按相关性排序', color: C.yellow},
  {stage: 'HANDOFF', count: '7 FINDINGS', path: '证据、路径、风险与下一步', note: '交还主 Agent', color: C.green},
];

const EvidenceRow: React.FC<{frame: number; cue: number; item: typeof evidence[number]; index: number}> = ({frame, cue, item, index}) => {
  const {fps} = useVideoConfig();
  const p = spring({frame: frame - cue, fps, config: {damping: 15, stiffness: 150, mass: .75}});
  const settle = ease(frame, cue + 15, cue + 21);
  return <div style={{height: 122, position: 'relative', perspective: 900}}>
    <div style={{height: 112, display: 'grid', gridTemplateColumns: '150px 210px 1fr 220px', alignItems: 'center', padding: '0 28px', boxSizing: 'border-box', border: `1px solid ${C.line}`, background: C.panel2, borderRadius: 12, transform: `translateY(${-110 * (1 - p)}px) rotateX(${16 * (1 - p)}deg) scale(${1 + .045 * (1 - settle) * p})`, transformOrigin: '50% 100%', opacity: p, boxShadow: `0 ${22 * (1 - p)}px 50px rgba(0,0,0,.55)`}}>
      <div style={{fontFamily: mono, color: item.color, fontSize: 21, fontWeight: 800}}>{item.stage}</div>
      <div style={{fontFamily: mono, color: C.white, fontSize: 18}}>{item.count}</div>
      <div style={{fontFamily: mono, color: C.muted, fontSize: 17}}>{item.path}</div>
      <div style={{fontFamily: mono, color: C.dim, fontSize: 15, textAlign: 'right'}}>{item.note}</div>
    </div>
    <div style={{position: 'absolute', left: '50%', bottom: 9, height: 2, width: `${settle * 100}%`, transform: 'translateX(-50%)', background: item.color, opacity: (1 - ease(frame, cue + 21, cue + 30)), boxShadow: `0 0 14px ${item.color}`}} />
  </div>;
};

export const FastContextScene: React.FC = () => {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{background: C.bg, overflow: 'hidden', padding: '76px 110px', boxSizing: 'border-box'}}>
    <GridBackground opacity={.1} />
    <div style={{position: 'relative', display: 'grid', gridTemplateColumns: '560px 1fr', gap: 72, height: '100%'}}>
      <div style={{display: 'flex', flexDirection: 'column', justifyContent: 'center', opacity: ease(frame, 0, 20)}}>
        <SceneLabel eyebrow="01 / FASTCONTEXT" title="证据先于结论。" subtitle="隔离映射、读取、排序，再把最相关的证据交还主 Agent。" />
        <div style={{marginTop: 42, display: 'flex', gap: 12}}><Badge color={C.info}>ISOLATED</Badge><Badge color={C.green}>RANKED</Badge><Badge>TRACEABLE</Badge></div>
      </div>
      <div style={{display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3}}>
        {evidence.map((item, index) => <EvidenceRow key={item.stage} frame={frame} cue={18 + index * 18} item={item} index={index} />)}
      </div>
    </div>
    <div style={{position: 'absolute', right: 82, top: 54, fontFamily: mono, color: C.dim, fontSize: 14, letterSpacing: 2}}>EVIDENCE ENGINE / 04 STAGES</div>
  </AbsoluteFill>;
};

const agents = [
  {name: 'RESEARCH', detail: 'auth flow mapped', color: C.info, x: 190, y: 180},
  {name: 'IMPLEMENT', detail: '2 files patched', color: C.cyan, x: 190, y: 600},
  {name: 'TEST', detail: 'target checks passed', color: C.green, x: 1370, y: 170},
  {name: 'TERMINAL', detail: 'detached · running', color: C.info, x: 1370, y: 590},
  {name: 'GIT', detail: 'diff structured', color: C.cyan, x: 790, y: 760},
];

const AgentCard: React.FC<{frame: number; cue: number; agent: typeof agents[number]; index: number}> = ({frame, cue, agent, index}) => {
  const {fps} = useVideoConfig();
  const p = spring({frame: frame - cue, fps, config: {damping: 14, stiffness: 180, mass: .76}});
  const startX = 820;
  const startY = 480;
  const arc = Math.sin(clamp(p) * Math.PI) * (90 + index * 10);
  const x = startX + (agent.x - startX) * p;
  const y = startY + (agent.y - startY) * p - arc;
  return <div style={{position: 'absolute', left: x, top: y, width: 360, height: 150, transform: `rotate(${(1 - p) * (index % 2 ? 8 : -8)}deg) scale(${.88 + .12 * p})`, opacity: p, border: `1px solid ${agent.color}66`, borderRadius: 14, background: '#0D0D0D', boxShadow: `0 18px 55px rgba(0,0,0,.65), 0 0 30px ${agent.color}16`, padding: 22, boxSizing: 'border-box', fontFamily: mono}}>
    <div style={{display: 'flex', alignItems: 'center', gap: 12}}><span style={{width: 10, height: 10, borderRadius: 5, background: agent.color, boxShadow: `0 0 14px ${agent.color}`}} /><span style={{fontSize: 18, color: agent.color, fontWeight: 800, letterSpacing: 1.5}}>{agent.name}</span><span style={{marginLeft: 'auto', color: C.green, fontSize: 14}}>● LIVE</span></div>
    <div style={{color: C.white, fontSize: 21, marginTop: 25}}>{agent.detail}</div>
    <div style={{height: 3, background: C.lineSoft, borderRadius: 3, marginTop: 18}}><div style={{width: `${64 + index * 7}%`, height: 3, background: agent.color}} /></div>
  </div>;
};

export const AgentsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const centerP = ease(frame, 0, 20);
  return <AbsoluteFill style={{background: C.bg, overflow: 'hidden'}}>
    <GridBackground opacity={.16} />
    <svg width="1920" height="1080" style={{position: 'absolute', inset: 0, opacity: ease(frame, 24, 66)}}>
      {agents.map((agent, index) => <line key={agent.name} x1="960" y1="535" x2={agent.x + 180} y2={agent.y + 75} stroke={agent.color} strokeOpacity=".33" strokeWidth="2" strokeDasharray="8 12" strokeDashoffset={-frame * (1.2 + index * .08)} />)}
    </svg>
    <div style={{position: 'absolute', left: 700, top: 390, width: 520, height: 290, border: `1px solid ${C.cyan}88`, background: '#090F11', borderRadius: 20, boxShadow: `0 0 80px ${C.cyan}22`, transform: `scale(${.86 + .14 * centerP})`, opacity: centerP, padding: 34, boxSizing: 'border-box', fontFamily: mono}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 16}}><BrandMark size={46} compact /><span style={{color: C.white, fontSize: 25, fontWeight: 800}}>MAIN AGENT</span><Badge color={C.green}>ORCHESTRATING</Badge></div>
      <div style={{fontSize: 18, color: C.muted, lineHeight: 1.6, marginTop: 32}}>将研究、实现、测试、后台终端与 Git 工作拆分并行，结果持续回流。</div>
      <div style={{display: 'flex', gap: 10, marginTop: 28}}>{['TOOLS 07', 'AGENTS 05', 'QUEUE 02'].map((text) => <Badge key={text} color={C.info}>{text}</Badge>)}</div>
    </div>
    {agents.map((agent, index) => <AgentCard key={agent.name} frame={frame} cue={18 + index * Math.max(5, 12 - index)} agent={agent} index={index} />)}
    <div style={{position: 'absolute', left: 82, top: 72, fontFamily: mono, opacity: ease(frame, 8, 22)}}><div style={{color: C.cyan, fontSize: 16, letterSpacing: 4}}>02 / ORCHESTRATION</div><div style={{color: C.white, fontSize: 58, fontWeight: 800, marginTop: 12}}>不是等待。是并行推进。</div></div>
  </AbsoluteFill>;
};

export const PermissionScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const modal = spring({frame: frame - 12, fps, config: {damping: 17, stiffness: 125, mass: .8}});
  const sweep = linear(frame, 18, 104);
  const click = frame >= 95;
  const accepted = ease(frame, 96, 111);
  const head = -300 + sweep * 1440;
  return <AbsoluteFill style={{background: C.bg, overflow: 'hidden'}}>
    <div style={{position: 'absolute', inset: 34, opacity: .28, filter: 'blur(2px)', transform: 'scale(.98)'}}><WindowFrame style={{height: '100%'}}><Dashboard frame={90} /></WindowFrame></div>
    <AbsoluteFill style={{background: 'rgba(0,0,0,.72)'}} />
    <div style={{position: 'absolute', left: 400, top: 230, width: 1120, height: 620, background: '#0B0B0B', borderRadius: 18, border: `1px solid ${C.yellow}66`, overflow: 'hidden', boxShadow: `0 50px 140px rgba(0,0,0,.8), 0 0 70px ${C.yellow}16`, opacity: modal, transform: `translateY(${70 * (1 - modal)}px) scale(${.95 + .05 * modal})`}}>
      <div style={{height: 74, borderBottom: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', padding: '0 30px', fontFamily: mono}}>
        <Badge color={C.yellow}>PERMISSION REQUIRED</Badge><span style={{marginLeft: 'auto', color: C.dim, fontSize: 15}}>write + execute</span>
      </div>
      <div style={{padding: '48px 54px', fontFamily: mono}}>
        <div style={{color: C.white, fontSize: 32, fontWeight: 800}}>允许 TurboFlux 执行以下操作？</div>
        <div style={{marginTop: 30, padding: '24px 28px', borderRadius: 12, background: '#060606', border: `1px solid ${C.line}`, color: C.cyan, fontSize: 20}}>$ npm run test -- auth && git diff --check</div>
        <div style={{marginTop: 18, color: C.muted, fontSize: 17}}>工作区：~/studio/aurora · 仅本次授权 · 命令将记录到会话日志</div>
        <div style={{display: 'flex', gap: 16, marginTop: 48}}>
          <div style={{height: 64, padding: '0 24px', borderRadius: 10, display: 'flex', alignItems: 'center', color: click ? C.bg : C.yellow, background: click ? C.green : `${C.yellow}18`, border: `1px solid ${click ? C.green : C.yellow}`, fontSize: 18, fontWeight: 800, transform: `scale(${1 - .035 * ease(frame, 92, 98) + .035 * accepted})`, boxShadow: click ? `0 0 30px ${C.green}44` : 'none'}}>{click ? '✓ 已允许一次' : '[A] 允许一次'}</div>
          <div style={{height: 64, padding: '0 24px', borderRadius: 10, display: 'flex', alignItems: 'center', color: C.muted, border: `1px solid ${C.line}`, fontSize: 18}}>[D] 拒绝</div>
          <div style={{height: 64, padding: '0 24px', borderRadius: 10, display: 'flex', alignItems: 'center', color: C.muted, border: `1px solid ${C.line}`, fontSize: 18}}>[E] 编辑命令</div>
        </div>
      </div>
      <div style={{position: 'absolute', left: head - 300, top: -2, width: 600, height: 5, background: `linear-gradient(90deg, transparent, ${C.yellow}, #fff, ${C.yellow}, transparent)`, filter: 'blur(.5px)', boxShadow: `0 0 24px ${C.yellow}`}} />
      <div style={{position: 'absolute', left: head - 460, top: 0, width: 920, height: 260, background: `radial-gradient(ellipse 460px 130px at 50% 0%, ${C.yellow}1f, transparent 72%)`, pointerEvents: 'none'}} />
    </div>
    <div style={{position: 'absolute', left: 0, right: 0, bottom: 66, textAlign: 'center', fontFamily: mono, opacity: ease(frame, 0, 18)}}><span style={{color: C.white, fontSize: 56, fontWeight: 800}}>速度有边界。</span><span style={{color: C.muted, fontSize: 32, marginLeft: 24}}>关键写入与命令始终由你决定。</span></div>
  </AbsoluteFill>;
};

const diffLines = [
  {prefix: ' ', text: 'export async function refreshSession(ctx) {', color: C.muted},
  {prefix: '-', text: '  return issueToken(ctx.user);', color: C.red},
  {prefix: '+', text: '  const claims = await verifyScope(ctx.user);', color: C.green},
  {prefix: '+', text: '  return issueToken(ctx.user, claims);', color: C.green},
  {prefix: ' ', text: '}', color: C.muted},
  {prefix: '+', text: 'test("rejects expired refresh tokens", async () => {', color: C.green},
  {prefix: '+', text: '  await expect(refresh(expired)).rejects.toThrow();', color: C.green},
  {prefix: '+', text: '});', color: C.green},
];

const DiffLine: React.FC<{frame: number; cue: number; line: typeof diffLines[number]; index: number; cues: number[]}> = ({frame, cue, line, index, cues}) => {
  const {fps} = useVideoConfig();
  const p = spring({frame: frame - cue, fps, config: {damping: 16, stiffness: 145, mass: .7}});
  const stackPress = cues.slice(index + 1).reduce((sum, nextCue) => sum + interpolate(frame, [nextCue + 10, nextCue + 14, nextCue + 20], [0, 6, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}), 0);
  return <div style={{height: 62, display: 'flex', alignItems: 'center', transform: `translateY(${90 * (1 - p) + stackPress}px)`, opacity: p, borderBottom: `1px solid ${C.lineSoft}`, background: line.prefix === '+' ? `${C.green}0a` : line.prefix === '-' ? `${C.red}0b` : 'transparent', padding: '0 22px', boxSizing: 'border-box', fontFamily: mono, fontSize: 17}}>
    <span style={{width: 36, color: line.color, fontWeight: 800}}>{line.prefix}</span><span style={{color: line.prefix === ' ' ? C.muted : C.white}}>{line.text}</span>
  </div>;
};

export const GitScene: React.FC = () => {
  const frame = useCurrentFrame();
  const score = ease(frame, 118, 145);
  const diffCues = diffLines.map((_, index) => 14 + index * 12);
  return <AbsoluteFill style={{background: C.bg, overflow: 'hidden', padding: '72px 96px', boxSizing: 'border-box'}}>
    <GridBackground opacity={.1} />
    <div style={{position: 'relative', height: '100%', display: 'grid', gridTemplateColumns: '480px 1fr', gap: 66}}>
      <div style={{display: 'flex', flexDirection: 'column', justifyContent: 'center', opacity: ease(frame, 0, 18)}}>
        <SceneLabel eyebrow="03 / REVIEWABLE DELIVERY" title="不只完成。还能证明。" subtitle="测试结果、结构化 diff 与 Git 状态，在交付前一起落定。" />
        <div style={{marginTop: 40, display: 'flex', flexDirection: 'column', gap: 12}}>
          <Badge color={C.green}>✓ 672 PASSED · 3 SKIPPED</Badge>
          <Badge color={C.muted}>1 KNOWN GIT TIMEOUT</Badge>
          <Badge color={C.info}>4 FILES · +18 / −4</Badge>
          <Badge color={C.cyan}>git diff --check · CLEAN</Badge>
        </div>
      </div>
      <WindowFrame title="git diff · feature/auth-proof" right={<Badge color={C.green}>EVIDENCE READY</Badge>} style={{height: 780, alignSelf: 'center'}}>
        <div style={{height: 64, display: 'flex', alignItems: 'center', gap: 18, padding: '0 24px', borderBottom: `1px solid ${C.line}`, fontFamily: mono, color: C.muted, fontSize: 15}}><span style={{color: C.cyan}}>src/auth/session.ts</span><span>·</span><span>tests/auth/session.test.ts</span></div>
        <div>{diffLines.map((line, index) => <DiffLine key={`${line.prefix}-${index}`} frame={frame} cue={diffCues[index]} line={line} index={index} cues={diffCues} />)}</div>
        <div style={{height: 100, display: 'flex', alignItems: 'center', padding: '0 24px', gap: 18, fontFamily: mono, opacity: score, transform: `translateY(${18 * (1 - score)}px)`}}>
          <span style={{width: 42, height: 42, borderRadius: 21, display: 'grid', placeItems: 'center', background: C.green, color: C.bg, fontWeight: 900}}>✓</span>
          <span style={{color: C.white, fontSize: 19}}>目标测试通过；已知集成超时已披露。</span>
        </div>
      </WindowFrame>
    </div>
  </AbsoluteFill>;
};

const stripStyle = (frame: number, start: number, dx: number, dy: number) => {
  const p = interpolate(frame, [start, start + 16], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.in(Easing.quad)});
  return {opacity: 1 - p, transform: `translate(${dx * p}px, ${dy * p}px)`};
};

export const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const click = 24;
  const bgDark = ease(frame, 48, 86);
  const buttonCenter = ease(frame, 45, 72);
  const buttonFade = interpolate(frame, [90, 104], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const logoP = ease(frame, 100, 126);
  const buttonX = 1520 + (960 - 116 - 1520) * buttonCenter;
  const buttonY = 46 + (540 - 34 - 46) * buttonCenter;
  const cursorX = interpolate(frame, [0, 20], [1050, 1610], {extrapolateRight: 'clamp', easing: Easing.inOut(Easing.quad)});
  const cursorY = interpolate(frame, [0, 20], [720, 70], {extrapolateRight: 'clamp', easing: Easing.inOut(Easing.quad)});
  return <AbsoluteFill style={{background: C.bg, overflow: 'hidden'}}>
    <AbsoluteFill style={{opacity: 1 - bgDark}}><GridBackground opacity={.16} /></AbsoluteFill>
    <div style={{position: 'absolute', left: 40, top: 40, width: 300, height: 1000, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, padding: 28, boxSizing: 'border-box', ...stripStyle(frame, 31, -170, 10)}}>
      <BrandMark size={38} />
      {['SESSION', 'CONTEXT', 'AGENTS', 'TERMINALS', 'GIT'].map((text, index) => <div key={text} style={{marginTop: 34, color: index === 4 ? C.green : C.muted, fontFamily: mono, fontSize: 16}}>{String(index + 1).padStart(2, '0')} / {text}</div>)}
    </div>
    <div style={{position: 'absolute', right: 40, top: 110, width: 320, height: 890, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, padding: 28, boxSizing: 'border-box', ...stripStyle(frame, 35, 160, 20)}}>
      <div style={{fontFamily: mono, color: C.dim, letterSpacing: 2}}>DELIVERY PROOF</div>
      {['tests passed', 'diff clean', 'branch ready', 'session saved'].map((text, index) => <div key={text} style={{display: 'flex', gap: 12, marginTop: 30, fontFamily: mono, color: C.white}}><span style={{color: C.green}}>✓</span>{text}</div>)}
    </div>
    <div style={{position: 'absolute', left: 390, top: 140, width: 1100, height: 790, background: '#0A0A0A', border: `1px solid ${C.line}`, borderRadius: 18, overflow: 'hidden', ...stripStyle(frame, 40, 0, 80)}}>
      <Dashboard frame={110} dense />
    </div>
    <div style={{position: 'absolute', left: 360, right: 360, top: 40, height: 66, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 14, ...stripStyle(frame, 43, 0, -80)}} />
    <div style={{position: 'absolute', left: buttonX, top: buttonY, width: 232, height: 68, borderRadius: 12, background: frame >= click ? C.green : C.cyan, boxShadow: `0 0 ${28 + buttonCenter * 44}px ${frame >= click ? C.green : C.cyan}66`, display: 'grid', placeItems: 'center', fontFamily: mono, color: C.bg, fontWeight: 900, fontSize: 20, letterSpacing: 1, zIndex: 20, opacity: buttonFade, transform: `scale(${1 + buttonCenter * .34 - .07 * ease(frame, click, click + 5)})`}}>{frame >= click ? '✓ DELIVERED' : 'DELIVER'}</div>
    <svg width="38" height="44" viewBox="0 0 20 22" style={{position: 'absolute', left: cursorX, top: cursorY, zIndex: 30, opacity: interpolate(frame, [26, 36], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}}><path d="M2 1 L2 17 L6.5 13.2 L9.4 20 L12.4 18.7 L9.5 12 L15 11.6 Z" fill={C.white} stroke={C.bg} strokeWidth="1.4" /></svg>
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', opacity: logoP, transform: `scale(${.92 + .08 * logoP})`}}>
      <BrandMark size={100} />
      <div style={{fontFamily: mono, color: C.white, fontSize: 36, marginTop: 44, letterSpacing: 1}}>Flow from intent to proof.</div>
      <div style={{fontFamily: mono, color: C.muted, fontSize: 32, marginTop: 20, letterSpacing: 4}}>LOCAL · ORCHESTRATED · REVIEWABLE</div>
    </AbsoluteFill>
  </AbsoluteFill>;
};
