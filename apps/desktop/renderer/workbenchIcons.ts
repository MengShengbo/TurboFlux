import type { ApprovalPolicy } from '@turboflux/contracts'
import { createElement as createLucideElement, Ellipsis, Folder, FolderClosed, FolderOpen, Monitor, PanelLeftClose, PanelLeftOpen, Plus, Puzzle, Settings2, SquarePen, Workflow, type IconNode } from 'lucide'
const navigationIconNodes: Record<string, IconNode> = {
  newConversation: SquarePen,
  parallel: Workflow,
  pluginNav: Puzzle,
  settings: Settings2,
  sidebarCollapse: PanelLeftClose,
  sidebarExpand: PanelLeftOpen,
  folder: Folder,
  computer: Monitor,
  plus: Plus,
  more: Ellipsis,
}
const navigationIconMarkup = new Map<string, string>()

function lucideSvg(node: IconNode, className = ''): string {
  return createLucideElement(node, {
    class: `lucide-icon ${className}`.trim(),
    'aria-hidden': 'true',
    focusable: 'false',
    'stroke-width': 1.75,
  }).outerHTML
}

export const icon = (name: string) => {
  const cached = navigationIconMarkup.get(name)
  if (cached) return cached
  const node = navigationIconNodes[name]
  if (node || name === 'workspace') {
    const svg = name === 'workspace'
      ? lucideSvg(FolderClosed, 'workspace-folder-closed') + lucideSvg(FolderOpen, 'workspace-folder-open')
      : lucideSvg(node)
    const markup = `<span class="icon icon-${name}" aria-hidden="true">${svg}</span>`
    navigationIconMarkup.set(name, markup)
    return markup
  }
  const icons: Record<string, string> = {
    grid: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>',
    chat: '<svg viewBox="0 0 24 24"><path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H12l-4.5 4v-4H7.5A2.5 2.5 0 0 1 5 12.5z"/></svg>',
    spark: '<svg viewBox="0 0 24 24"><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".8"/><circle cx="4.5" cy="12" r=".8"/><circle cx="4.5" cy="18" r=".8"/></svg>',
    history: '<svg viewBox="0 0 24 24"><path d="M4 7v5h5"/><path d="M5.5 17.5A8 8 0 1 0 4 12"/><path d="M12 8v4l3 2"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/></svg>',
    globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
    forward: '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
    reload: '<svg viewBox="0 0 24 24"><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2 5"/></svg>',
    external: '<svg viewBox="0 0 24 24"><path d="M14 5h5v5M19 5l-8 8"/><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
    paperclip: '<svg viewBox="0 0 24 24"><path d="m8.5 12.5 6.8-6.8a3.2 3.2 0 0 1 4.5 4.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.2-8.2"/></svg>',
    paste: '<svg viewBox="0 0 24 24"><rect x="5" y="5.5" width="14" height="15" rx="2.5"/><path d="M9 5.5V4.2A1.7 1.7 0 0 1 10.7 2.5h2.6A1.7 1.7 0 0 1 15 4.2v1.3M8.5 10h7M8.5 13.5h7M8.5 17h4.5"/></svg>',
    plug: '<svg viewBox="0 0 24 24"><path d="M8 3v5m8-5v5M6 8h12v2a6 6 0 0 1-6 6v5m-3 0h6"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="m5 12 4.5 4.5L19 7"/></svg>',
    changeAdd: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/><circle cx="12" cy="12" r="8.5" opacity=".18"/></svg>',
    changeDelete: '<svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/><circle cx="12" cy="12" r="8.5" opacity=".18"/></svg>',
    changeModify: '<svg viewBox="0 0 24 24"><path d="m5 17.8 9.9-9.9 3.2 3.2-9.9 9.9H5z"/><path d="m13.8 8.9 1.7-1.7a2 2 0 0 1 2.8 0l.5.5a2 2 0 0 1 0 2.8l-1.7 1.7"/></svg>',
    arrow: '<svg viewBox="0 0 24 24"><path d="M21 3 10.6 13.4"/><path d="m21 3-6.7 18-3.7-7.6L3 9.7Z"/></svg>',
    sendUp: '<svg viewBox="0 0 24 24"><path d="m6.5 10.5 5.5-5.5 5.5 5.5M12 5v14"/></svg>',
    chevron: '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24"><path d="m6.5 9 5.5 5.5L17.5 9"/></svg>',
    command: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m9 9 2.5 3L9 15m4.5 0H16"/></svg>',
    terminal: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="m7.5 9 3 3-3 3M13 15h3.5"/></svg>',
    panel: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="16" rx="3"/><path d="M15 4v16"/></svg>',
    overview: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="7" height="7" rx="1.5"/><rect x="13.5" y="4" width="7" height="4" rx="1.5"/><rect x="13.5" y="11" width="7" height="9" rx="1.5"/><rect x="3.5" y="14" width="7" height="6" rx="1.5"/></svg>',
    activity: '<svg viewBox="0 0 24 24"><path d="M3.5 12h4l2.2-5.5 4.1 11 2.3-5.5h4.4"/><path d="M4 5.5h16M4 18.5h16" opacity=".35"/></svg>',
    browser: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9h17"/><circle cx="7" cy="6.75" r=".65"/><circle cx="10" cy="6.75" r=".65"/></svg>',
    outputs: '<svg viewBox="0 0 24 24"><path d="M7 3.5h7l4 4V20H7z"/><path d="M14 3.5V8h4M9.5 12h5M9.5 15.5h5"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M7 3.5h7l4 4V20H7z"/><path d="M14 3.5V8h4"/></svg>',
    image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="9.5" r="1.5"/><path d="m5.5 17 4.2-4 2.8 2.4 2.7-2.7 3.3 3.3"/></svg>',
    code: '<svg viewBox="0 0 24 24"><path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M14 4l-4 16"/></svg>',
    archive: '<svg viewBox="0 0 24 24"><path d="M5 8h14v11H5zM4 4h16v4H4z"/><path d="M10 12h4"/></svg>',
    table: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M10 4.5v15"/></svg>',
    slides: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="13" rx="2.5"/><path d="M12 17v3M8.5 20h7M8 8h8M8 12h5"/></svg>',
    context: '<svg viewBox="0 0 24 24"><path d="m12 3.5 8 4-8 4-8-4z"/><path d="m4 12 8 4 8-4M4 16.5l8 4 8-4"/></svg>',
    git: '<svg viewBox="0 0 24 24"><circle cx="7" cy="5" r="2"/><circle cx="17" cy="7" r="2"/><circle cx="7" cy="19" r="2"/><path d="M7 7v10M9 12h3a5 5 0 0 0 5-5"/></svg>',
    preview: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="12" rx="2.5"/><path d="M8 20h8M12 16.5V20"/><path d="m10 8.5 5 2.5-5 2.5z"/></svg>',
    expand: '<svg viewBox="0 0 24 24"><path d="M8 4H4v4M16 20h4v-4M4 8l5-5M20 16l-5 5"/></svg>',
    contract: '<svg viewBox="0 0 24 24"><path d="M9 9H4V4M15 15h5v5M4 4l6 6M20 20l-6-6"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M9 6v12M15 6v12"/></svg>',
    pauseBlock: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="m9 6 9 6-9 6z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V5h6v2m-8 0 1 12h8l1-12M10 10v6m4-6v6"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></svg>',
    account: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg>',
    approvalAsk: '<svg viewBox="0 0 24 24"><path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H12l-4.5 4v-4h-.5A2.5 2.5 0 0 1 5 12.5z"/><path d="M10 9a2 2 0 1 1 3.3 1.5c-.8.6-1.3 1-1.3 2"/><path d="M12 15h.01"/></svg>',
    approvalAgent: '<svg viewBox="0 0 24 24"><path d="M12 3.5 19 6v5.2c0 4.1-2.5 7.6-7 9.3-4.5-1.7-7-5.2-7-9.3V6z"/><path d="m8.8 11.8 2.1 2.1 4.5-4.6"/></svg>',
    approvalFull: '<svg viewBox="0 0 24 24"><path d="M12 3.5 19 6v5.2c0 4.1-2.5 7.6-7 9.3-4.5-1.7-7-5.2-7-9.3V6z"/><path d="M12 8v5"/><path d="M12 16.5h.01"/></svg>',
  }
  return `<span class="icon icon-${name}">${icons[name] || icons.grid}</span>`
}

export function approvalPolicyIcon(policy: ApprovalPolicy): string {
  const icons: Record<ApprovalPolicy, string> = {
    ask: icon('approvalAsk'),
    agent: icon('approvalAgent'),
    full: icon('approvalFull'),
  }
  return icons[policy]
}
