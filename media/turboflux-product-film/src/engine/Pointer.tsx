export const Pointer = ({x, y, opacity = 1, press = 0}: {x: number; y: number; opacity?: number; press?: number}) => (
  <div style={{position: 'absolute', left: x, top: y, width: 42, height: 52, opacity, transform: `translate(-4px,-3px) scale(${1 - press * 0.12})`, transformOrigin: '4px 3px', filter: 'drop-shadow(0 5px 8px rgba(0,0,0,0.20))', pointerEvents: 'none'}}>
    <svg viewBox="0 0 42 52" width="42" height="52"><path d="M4 3L36 30L22 33L29 47L20 51L13 36L4 44Z" fill="#fff" stroke="#111" strokeWidth="3" strokeLinejoin="round" /></svg>
    <div style={{position: 'absolute', left: -14, top: -14, width: 54, height: 54, borderRadius: 99, border: '3px solid rgba(22,119,255,0.55)', opacity: press, transform: `scale(${0.55 + press * 0.85})`}} />
  </div>
);
