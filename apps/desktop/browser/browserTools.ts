import type { McpLocalToolDefinition } from '@turboflux/agent-core/extensions'

export const MAX_OBSERVED_ELEMENTS = 160

export function browserTools(): McpLocalToolDefinition[] {
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  const action = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  const localLayout = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  const localLifecycle = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  return [
    {
      name: 'capabilities',
      description: 'Report the exact Browser backend and supported semantic, frame, coordinate, file, lifecycle, authentication, and external-tab capabilities. Use this instead of assuming every browser backend behaves alike.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'open',
      description: 'Open a new background browser tab at a URL or focused search query. The tab is surfaced in the task drawer for the user. Use wait and observe after navigation, then open strong primary sources in separate tabs.',
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'HTTP(S) URL or search query' } }, required: ['url'], additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'tabs',
      description: 'List browser tabs and the active tab.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'activate',
      description: 'Make a browser tab active in the user-visible browsing trail before continuing work on it.',
      inputSchema: { type: 'object', properties: { tab_id: { type: 'string' } }, required: ['tab_id'], additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'navigate',
      description: 'Navigate the active or specified tab to an HTTP(S) URL or search query.',
      inputSchema: { type: 'object', properties: { url: { type: 'string' }, tab_id: { type: 'string' } }, required: ['url'], additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'observe',
      description: 'Read visible text and user-facing interactive elements across the top document and reachable iframes. Returns short-lived frame-aware refs for this observation; observe again after navigation or page changes.',
      inputSchema: { type: 'object', properties: { tab_id: { type: 'string' }, max_elements: { type: 'integer', minimum: 1, maximum: MAX_OBSERVED_ELEMENTS } }, additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'find',
      description: 'Find interactive page elements across the top document and reachable iframes by visible label, accessible name, placeholder, title, role, or link target.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, role: { type: 'string' }, max_results: { type: 'integer', minimum: 1, maximum: 30, default: 12 }, tab_id: { type: 'string' } }, required: ['query'], additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'click',
      description: 'Click an element ref returned by observe or find. Top-frame targets use native input with DOM fallback; iframe targets use frame-scoped semantic activation. Supports double-clicking.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' }, click_count: { type: 'integer', enum: [1, 2], default: 1 }, tab_id: { type: 'string' } }, required: ['ref'], additionalProperties: false },
      annotations: action,
    },
    {
      name: 'type',
      description: 'Replace text in an editable element ref. Password fields are intentionally blocked; the user must fill them manually. This may disclose data to the page and requires approval.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean', default: false }, tab_id: { type: 'string' } }, required: ['ref', 'text'], additionalProperties: false },
      annotations: action,
    },
    {
      name: 'press',
      description: 'Press one bounded keyboard key on an observed element or the currently focused page element. Supports Enter, Tab, Escape, Space, arrows, Home, End, PageUp, PageDown, Backspace, and Delete.',
      inputSchema: { type: 'object', properties: { key: { type: 'string' }, ref: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string', enum: ['shift', 'control', 'alt', 'meta'] }, maxItems: 4 }, tab_id: { type: 'string' } }, required: ['key'], additionalProperties: false },
      annotations: action,
    },
    {
      name: 'select_option',
      description: 'Select one or more values in a native select element returned by observe.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' }, values: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 }, tab_id: { type: 'string' } }, required: ['ref', 'values'], additionalProperties: false },
      annotations: action,
    },
    {
      name: 'set_checked',
      description: 'Set a checkbox or radio input returned by observe to a checked state.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' }, checked: { type: 'boolean', default: true }, tab_id: { type: 'string' } }, required: ['ref'], additionalProperties: false },
      annotations: action,
    },
    {
      name: 'upload_file',
      description: 'Attach one existing workspace file to an observed native file input. The ref must come from the latest observe call. This shares a local file with the current page and requires approval.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' }, path: { type: 'string', description: 'Workspace-relative or absolute path inside the active workspace' }, tab_id: { type: 'string' } }, required: ['ref', 'path'], additionalProperties: false },
      annotations: action,
    },
    {
      name: 'hover',
      description: 'Hover an observed element to reveal menus, tooltips, or hover states.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' }, tab_id: { type: 'string' } }, required: ['ref'], additionalProperties: false },
      annotations: action,
    },
    {
      name: 'click_at',
      description: 'Click viewport coordinates. Use only for canvas, games, or controls that cannot be reached through observe refs.',
      inputSchema: { type: 'object', properties: { x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 }, tab_id: { type: 'string' } }, required: ['x', 'y'], additionalProperties: false },
      annotations: action,
    },
    {
      name: 'drag',
      description: 'Drag between viewport coordinates for sliders, canvas, boards, and drag-and-drop interfaces.',
      inputSchema: { type: 'object', properties: { from_x: { type: 'number', minimum: 0 }, from_y: { type: 'number', minimum: 0 }, to_x: { type: 'number', minimum: 0 }, to_y: { type: 'number', minimum: 0 }, tab_id: { type: 'string' } }, required: ['from_x', 'from_y', 'to_x', 'to_y'], additionalProperties: false },
      annotations: action,
    },
    {
      name: 'scroll',
      description: 'Scroll the active or specified page.',
      inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'integer', minimum: 100, maximum: 3000, default: 700 }, tab_id: { type: 'string' } }, required: ['direction'], additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'wait',
      description: 'Wait for page loading, visible text, a URL fragment, or an observed element. Timeouts are bounded to 15 seconds.',
      inputSchema: { type: 'object', properties: { condition: { type: 'string', enum: ['load', 'text', 'url', 'element'] }, value: { type: 'string' }, ref: { type: 'string' }, timeout_ms: { type: 'integer', minimum: 100, maximum: 15000, default: 5000 }, tab_id: { type: 'string' } }, required: ['condition'], additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'assert',
      description: 'Check visible text, URL, or an observed element state and return a structured pass/fail result without modifying the page.',
      inputSchema: { type: 'object', properties: { condition: { type: 'string', enum: ['text_contains', 'url_contains', 'element_visible', 'element_enabled', 'element_checked'] }, value: { type: 'string' }, ref: { type: 'string' }, tab_id: { type: 'string' } }, required: ['condition'], additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'diagnostics',
      description: 'Read bounded console warnings/errors and failed or HTTP 4xx/5xx requests for the current page. Sensitive URL query strings are removed.',
      inputSchema: { type: 'object', properties: { clear: { type: 'boolean', default: false }, tab_id: { type: 'string' } }, additionalProperties: false },
      annotations: readOnly,
    },
    ...(['back', 'forward', 'reload'] as const).map(name => ({
      name,
      description: `${name[0].toUpperCase()}${name.slice(1)} the active or specified browser tab.`,
      inputSchema: { type: 'object', properties: { tab_id: { type: 'string' } }, additionalProperties: false },
      annotations: readOnly,
    })),
    {
      name: 'screenshot',
      description: 'Capture the visible browser viewport to the workspace and return its file path.',
      inputSchema: { type: 'object', properties: { tab_id: { type: 'string' } }, additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'visual_observe',
      description: 'Capture the current visible viewport and attach it to the next model request for actual visual inspection. Use for canvas, games, charts, visual layout, or controls that DOM observation cannot explain.',
      inputSchema: { type: 'object', properties: { tab_id: { type: 'string' } }, additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'set_layout',
      description: 'Choose the user-visible browser drawer layout. Use landscape for video, wide tables, dashboards, canvases, and other horizontal pages. Use portrait for reading, forms, and narrow pages. This only changes the local drawer size.',
      inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['portrait', 'landscape'] } }, required: ['mode'], additionalProperties: false },
      annotations: localLayout,
    },
    {
      name: 'mark_deliverable',
      description: 'Keep the active or specified tab as a user-facing task result when temporary research tabs are cleaned up.',
      inputSchema: { type: 'object', properties: { tab_id: { type: 'string' } }, additionalProperties: false },
      annotations: localLifecycle,
    },
    {
      name: 'mark_handoff',
      description: 'Keep the active or specified tab open for user takeover or continued Agent work after the current task ends.',
      inputSchema: { type: 'object', properties: { tab_id: { type: 'string' } }, additionalProperties: false },
      annotations: localLifecycle,
    },
    {
      name: 'close',
      description: 'Close the active or specified browser tab.',
      inputSchema: { type: 'object', properties: { tab_id: { type: 'string' } }, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ]
}
