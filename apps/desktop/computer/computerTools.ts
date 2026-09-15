import type { McpLocalToolDefinition } from '@turboflux/agent-core/extensions'

export const MAX_DRAG_POINTS = 24

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const observe = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
const action = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }

function targetProperties(): Record<string, unknown> {
  return {
    app_name: { type: 'string', description: 'Visible application name from list_apps or observe' },
    bundle_id: { type: 'string', description: 'Exact application bundle identifier from list_apps or observe' },
    description: { type: 'string', description: 'Short user-facing description of the intended action. Never include secrets.' },
    safety_class: {
      type: 'string',
      enum: ['routine', 'external', 'sensitive', 'destructive', 'payment', 'system', 'credential'],
      description: 'Classify the immediate effect. external means sending/submitting/publishing; credential requires user takeover.',
    },
  }
}

function observationActionProperties(): Record<string, unknown> {
  return {
    observation_id: { type: 'string', description: 'Fresh observation_id returned by observe or the previous computer action' },
    ...targetProperties(),
  }
}

export function computerTools(): McpLocalToolDefinition[] {
  return [
    {
      name: 'status',
      description: 'Read computer-control availability, macOS permissions, displays, pause state, and the active application. Does not capture the screen.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'list_apps',
      description: 'List running foreground applications with exact names, process ids, and bundle identifiers. Protected apps are marked and cannot be controlled.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: readOnly,
    },
    {
      name: 'open_app',
      description: 'Open an installed application and bring it to the foreground. Terminal, password managers, System Settings, and TurboFlux itself are blocked.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          bundle_id: { type: 'string' },
          description: targetProperties().description,
          safety_class: targetProperties().safety_class,
          app_name: targetProperties().app_name,
        },
        anyOf: [{ required: ['name'] }, { required: ['bundle_id'] }],
        required: ['app_name', 'description', 'safety_class'],
        additionalProperties: false,
      },
      annotations: action,
    },
    {
      name: 'focus_app',
      description: 'Bring a running application to the foreground. Use list_apps first and supply its exact pid and bundle identifier.',
      inputSchema: {
        type: 'object',
        properties: { pid: { type: 'integer', minimum: 1 }, ...targetProperties() },
        required: ['pid', 'app_name', 'bundle_id', 'description', 'safety_class'],
        additionalProperties: false,
      },
      annotations: action,
    },
    {
      name: 'observe',
      description: 'Observe an application before acting. When a target app is supplied, TurboFlux first attempts background Accessibility inspection and only brings it forward when visual interaction is required. Returns a short-lived observation_id.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['window', 'display'], default: 'window', description: 'Window is the privacy-preserving default. Display requires broader visual access.' },
          display_id: { type: 'string' },
          pid: { type: 'integer', minimum: 1 },
          app_name: targetProperties().app_name,
          bundle_id: targetProperties().bundle_id,
          interaction_mode: { type: 'string', enum: ['auto', 'background', 'foreground'], default: 'auto', description: 'Auto prefers background semantic control and safely falls back to a visible foreground observation.' },
        },
        additionalProperties: false,
      },
      annotations: observe,
    },
    {
      name: 'click',
      description: 'Press an Accessibility element ref, or click screenshot coordinates when semantic controls are unavailable. Returns a fresh observation after the action.',
      inputSchema: {
        type: 'object',
        properties: {
          ...observationActionProperties(),
          ref: { type: 'string', description: 'Preferred Accessibility ref from the observation' },
          x: { type: 'number', minimum: 0 },
          y: { type: 'number', minimum: 0 },
          button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
        },
        anyOf: [{ required: ['ref'] }, { required: ['x', 'y'] }],
        required: ['observation_id', 'app_name', 'bundle_id', 'description', 'safety_class'],
        additionalProperties: false,
      },
      annotations: action,
    },
    {
      name: 'double_click',
      description: 'Double-click screenshot coordinates from a fresh observation. Returns a new observation after the action.',
      inputSchema: {
        type: 'object',
        properties: {
          ...observationActionProperties(),
          x: { type: 'number', minimum: 0 },
          y: { type: 'number', minimum: 0 },
          button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
        },
        required: ['observation_id', 'x', 'y', 'app_name', 'bundle_id', 'description', 'safety_class'],
        additionalProperties: false,
      },
      annotations: action,
    },
    {
      name: 'move',
      description: 'Move the pointer to screenshot coordinates without clicking. Returns a fresh observation.',
      inputSchema: {
        type: 'object',
        properties: { ...observationActionProperties(), x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 } },
        required: ['observation_id', 'x', 'y', 'app_name', 'bundle_id', 'description', 'safety_class'],
        additionalProperties: false,
      },
      annotations: { ...action, destructiveHint: false },
    },
    {
      name: 'drag',
      description: 'Drag through 2-24 screenshot-coordinate points from a fresh observation. Returns a new observation.',
      inputSchema: {
        type: 'object',
        properties: {
          ...observationActionProperties(),
          points: { type: 'array', minItems: 2, maxItems: MAX_DRAG_POINTS, items: { type: 'object', properties: { x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 } }, required: ['x', 'y'], additionalProperties: false } },
          button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
        },
        required: ['observation_id', 'points', 'app_name', 'bundle_id', 'description', 'safety_class'],
        additionalProperties: false,
      },
      annotations: action,
    },
    {
      name: 'scroll',
      description: 'Scroll at screenshot coordinates. Positive delta_y scrolls upward; negative scrolls downward. Returns a fresh observation.',
      inputSchema: {
        type: 'object',
        properties: {
          ...observationActionProperties(),
          x: { type: 'number', minimum: 0 },
          y: { type: 'number', minimum: 0 },
          delta_x: { type: 'number', minimum: -4000, maximum: 4000, default: 0 },
          delta_y: { type: 'number', minimum: -4000, maximum: 4000 },
        },
        required: ['observation_id', 'x', 'y', 'delta_y', 'app_name', 'bundle_id', 'description', 'safety_class'],
        additionalProperties: false,
      },
      annotations: { ...action, destructiveHint: false },
    },
    {
      name: 'type_text',
      description: 'Set an editable Accessibility ref or type Unicode directly into the focused control of the observed app. Passwords, OTPs, PINs, API keys, and secure fields are blocked. Returns a fresh observation.',
      inputSchema: {
        type: 'object',
        properties: {
          ...observationActionProperties(),
          ref: { type: 'string', description: 'Editable Accessibility ref; preferred over coordinate focus' },
          text: { type: 'string', minLength: 1, maxLength: 8000 },
          field_type: { type: 'string', enum: ['normal', 'search', 'message', 'document', 'password', 'credential', 'one-time-code', 'otp', 'pin'] },
        },
        required: ['observation_id', 'text', 'field_type', 'app_name', 'bundle_id', 'description', 'safety_class'],
        additionalProperties: false,
      },
      annotations: action,
    },
    {
      name: 'press',
      description: 'Send one bounded application-local key combination. Global system shortcuts are not supported. Returns a fresh observation.',
      inputSchema: {
        type: 'object',
        properties: { ...observationActionProperties(), keys: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } } },
        required: ['observation_id', 'keys', 'app_name', 'bundle_id', 'description', 'safety_class'],
        additionalProperties: false,
      },
      annotations: action,
    },
    {
      name: 'wait',
      description: 'Wait briefly for the target application to settle, then return a fresh observation. Use after loading, animation, dialogs, or asynchronous updates.',
      inputSchema: {
        type: 'object',
        properties: { milliseconds: { type: 'integer', minimum: 100, maximum: 10000, default: 800 }, description: { type: 'string' } },
        additionalProperties: false,
      },
      annotations: readOnly,
    },
    {
      name: 'assert',
      description: 'Check active app, window title, or an Accessibility element and return a pass/fail result with fresh visual evidence.',
      inputSchema: {
        type: 'object',
        properties: {
          condition: { type: 'string', enum: ['active_app', 'window_title_contains', 'element_present', 'element_value_contains'] },
          expected: { type: 'string' },
          ref: { type: 'string' },
        },
        required: ['condition', 'expected'],
        additionalProperties: false,
      },
      annotations: readOnly,
    },
    {
      name: 'handoff',
      description: 'Pause computer control for passwords, OTPs, CAPTCHA, administrator approval, privacy permissions, safety barriers, or any step the user must complete. After calling, ask the user to take over.',
      inputSchema: {
        type: 'object',
        properties: { ...targetProperties(), reason: { type: 'string' } },
        required: ['description', 'reason', 'safety_class'],
        additionalProperties: false,
      },
      annotations: action,
    },
  ]
}
