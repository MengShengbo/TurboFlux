import type {
  ComputerActionSafetyClass,
  ComputerToolActivityStatus,
  ComputerToolApprovalLevel,
  ComputerToolOperation,
} from './computerTypes'
import { COMPUTER_TOOL_OPERATIONS } from './computerTypes'

export interface ComputerToolActivityPresentation {
  title: string
  detail: string
  approvalLevel: ComputerToolApprovalLevel
  needsApproval: boolean
}

export interface ComputerPermissionPresentation {
  title: string
  question: string
  reason: string
  runningDetail: string
  approvalLevel: Exclude<ComputerToolApprovalLevel, 'none'>
}

interface ComputerToolDefinition {
  title: string
  running: string
  completed: string
  approvalLevel: ComputerToolApprovalLevel
  permissionAction?: string
  permissionReason?: string
}

const COMPUTER_TOOL_PREFIX = 'computer__'
const COMPUTER_TOOL_SET = new Set<string>(COMPUTER_TOOL_OPERATIONS)

const COMPUTER_TOOLS: Record<ComputerToolOperation, ComputerToolDefinition> = {
  status: {
    title: '检查电脑操控状态',
    running: '正在检查电脑操控能力',
    completed: '电脑操控状态已更新',
    approvalLevel: 'none',
  },
  observe: {
    title: '查看电脑画面',
    running: '正在查看当前画面',
    completed: '已查看当前画面',
    approvalLevel: 'none',
  },
  list_apps: {
    title: '查看打开的应用',
    running: '正在检查打开的应用',
    completed: '已检查打开的应用',
    approvalLevel: 'none',
  },
  open_app: {
    title: '打开应用',
    running: '正在打开应用',
    completed: '应用已打开',
    approvalLevel: 'policy',
    permissionAction: '打开应用',
    permissionReason: '这会启动目标应用并把它带到前台。',
  },
  focus_app: {
    title: '切换应用',
    running: '正在切换应用',
    completed: '已切换应用',
    approvalLevel: 'policy',
    permissionAction: '切换应用',
    permissionReason: '这会把目标应用带到前台，并改变当前键盘焦点。',
  },
  click: {
    title: '操作应用',
    running: '正在点击应用内容',
    completed: '已完成点击',
    approvalLevel: 'policy',
    permissionAction: '点击内容',
  },
  double_click: {
    title: '操作应用',
    running: '正在双击应用内容',
    completed: '已完成双击',
    approvalLevel: 'policy',
    permissionAction: '双击内容',
  },
  move: {
    title: '定位操作位置',
    running: '正在定位操作位置',
    completed: '已定位操作位置',
    approvalLevel: 'none',
  },
  drag: {
    title: '拖动应用内容',
    running: '正在拖动应用内容',
    completed: '已完成拖动',
    approvalLevel: 'policy',
    permissionAction: '拖动内容',
  },
  scroll: {
    title: '浏览应用内容',
    running: '正在浏览应用内容',
    completed: '已浏览应用内容',
    approvalLevel: 'none',
  },
  type_text: {
    title: '填写应用内容',
    running: '正在填写应用内容',
    completed: '已填写应用内容',
    approvalLevel: 'policy',
    permissionAction: '填写内容',
    permissionReason: '这会把内容输入目标应用，可能保存、提交或分享信息。',
  },
  press: {
    title: '使用键盘操作',
    running: '正在使用键盘操作应用',
    completed: '已完成键盘操作',
    approvalLevel: 'policy',
    permissionAction: '使用键盘操作',
  },
  wait: {
    title: '等待应用响应',
    running: '正在等待应用更新',
    completed: '应用已响应',
    approvalLevel: 'none',
  },
  assert: {
    title: '验证操作结果',
    running: '正在核对操作结果',
    completed: '已核对操作结果',
    approvalLevel: 'none',
  },
  handoff: {
    title: '接管电脑',
    running: '正在暂停操作并等待你接管',
    completed: '已进入用户接管',
    approvalLevel: 'always',
    permissionAction: '进入用户接管',
    permissionReason: '接管期间 TurboFlux 会暂停电脑操作，直到你明确继续。',
  },
}

const HIGH_IMPACT_SAFETY_CLASSES = new Set<ComputerActionSafetyClass>([
  'external',
  'sensitive',
  'destructive',
])

const SAFETY_PRIORITY: Record<ComputerActionSafetyClass, number> = {
  routine: 0,
  sensitive: 1,
  external: 2,
  destructive: 3,
  payment: 4,
  system: 5,
  credential: 6,
}

const CREDENTIAL_PATTERN = /(?:password|passcode|one[- ]?time|\botp\b|verification code|auth(?:entication)? code|api[- ]?key|access[- ]?token|secret|captcha|密码|口令|验证码|密钥|令牌)/iu
const PAYMENT_PATTERN = /(?:\bpay(?:ment)?\b|purchase|checkout|bank transfer|wire transfer|credit card|debit card|billing|financial transaction|付款|支付|购买|下单|转账|交易|银行卡|信用卡|扣款|订阅)/iu
const SYSTEM_PATTERN = /(?:administrator|admin approval|elevated privilege|system permission|privacy permission|security setting|install helper|system extension|管理员|系统权限|隐私权限|安全设置|辅助功能|屏幕录制|输入监控|安装系统|系统扩展)/iu
const DESTRUCTIVE_PATTERN = /(?:\bdelete\b|remove|erase|overwrite|uninstall|discard|empty trash|永久删除|删除|移除|清空|覆盖|卸载|丢弃)/iu
const EXTERNAL_PATTERN = /(?:\bsend\b|submit|publish|post|upload|share|email|message|comment|发送|提交|发布|上传|分享|邮件|留言|评论)/iu

export function isBuiltInComputerTool(name: unknown): name is string {
  return typeof name === 'string' && name.startsWith(COMPUTER_TOOL_PREFIX)
}

export function computerToolApprovalLevel(
  name: string,
  args: Record<string, unknown> = {},
): ComputerToolApprovalLevel | null {
  if (!isBuiltInComputerTool(name)) return null
  const operation = computerOperation(name)
  if (!isComputerToolOperation(operation)) return 'deny'
  const definition = COMPUTER_TOOLS[operation]
  if (operation === 'handoff') return 'always'
  const safetyClass = inferComputerActionSafetyClass(name, args)
  if (computerActionRequiresHandoff(name, args)) return 'deny'
  if (operation === 'observe' && args.scope === 'display') return 'always'
  if (definition.approvalLevel === 'none' || definition.approvalLevel === 'always') return definition.approvalLevel
  if (HIGH_IMPACT_SAFETY_CLASSES.has(safetyClass)) return 'always'
  return definition.approvalLevel
}

export function inferComputerActionSafetyClass(
  name: string,
  args: Record<string, unknown> = {},
): ComputerActionSafetyClass {
  const operation = isBuiltInComputerTool(name) ? computerOperation(name) : ''
  const candidates: ComputerActionSafetyClass[] = [computerSafetyClass(args) || 'routine']
  const descriptor = computerRiskDescriptor(args)

  if (hasCredentialSignals(args) || CREDENTIAL_PATTERN.test(descriptor)) candidates.push('credential')
  if (PAYMENT_PATTERN.test(descriptor)) candidates.push('payment')
  if (SYSTEM_PATTERN.test(descriptor)) candidates.push('system')
  if (DESTRUCTIVE_PATTERN.test(descriptor)) candidates.push('destructive')
  if (EXTERNAL_PATTERN.test(descriptor)) candidates.push('external')

  if ((operation === 'click' || operation === 'double_click')
    && !firstString(args, ['ref'])
    && (typeof args.x === 'number' || typeof args.y === 'number')) {
    candidates.push('sensitive')
  }
  if (operation === 'type_text' && typeof args.text === 'string' && /[\r\n]/.test(args.text)) {
    candidates.push('sensitive')
  }
  if (operation === 'press') {
    const keys = Array.isArray(args.keys) ? args.keys.map(value => String(value).trim().toLowerCase()) : []
    const keySet = new Set(keys)
    const meta = keySet.has('meta') || keySet.has('command') || keySet.has('cmd')
    if (keySet.has('enter') || keySet.has('return')) candidates.push('external')
    if (meta && keySet.has('v')) candidates.push('sensitive')
    if (meta && ['q', 'w', 'delete', 'backspace'].some(key => keySet.has(key))) candidates.push('destructive')
  }

  return candidates.reduce((highest, candidate) => (
    SAFETY_PRIORITY[candidate] > SAFETY_PRIORITY[highest] ? candidate : highest
  ), 'routine')
}

export function computerActionRequiresHandoff(
  name: string,
  args: Record<string, unknown> = {},
): boolean {
  if (name === `${COMPUTER_TOOL_PREFIX}handoff`) return false
  const safetyClass = inferComputerActionSafetyClass(name, args)
  return safetyClass === 'credential' || safetyClass === 'payment' || safetyClass === 'system'
}

export function computerPermissionGrantGroup(
  _name: string,
  _args: Record<string, unknown>,
): string | undefined {
  return undefined
}

export function describeComputerToolActivity(
  name: string,
  args: Record<string, unknown>,
  status: ComputerToolActivityStatus,
): ComputerToolActivityPresentation | null {
  if (!isBuiltInComputerTool(name)) return null
  const operation = computerOperation(name)
  const definition = isComputerToolOperation(operation)
    ? COMPUTER_TOOLS[operation]
    : {
        title: '电脑操作已阻止',
        running: '该电脑操作不可用',
        completed: '该电脑操作不可用',
        approvalLevel: 'deny' as const,
      }
  const approvalLevel = computerToolApprovalLevel(name, args) || 'deny'
  const target = computerTargetAppName(args)
  const detail = approvalLevel === 'deny'
    ? isComputerToolOperation(operation)
      ? appendTarget('这一步需要由你接管完成', target)
      : '该电脑操作不可用'
    : status === 'failed'
      ? appendTarget('暂未完成，智能代理将重新观察后继续', target)
      : appendTarget(status === 'running' ? definition.running : definition.completed, target)
  return {
    title: definition.title,
    detail,
    approvalLevel,
    needsApproval: approvalLevel === 'policy' || approvalLevel === 'always',
  }
}

export function describeComputerPermission(
  name: string,
  args: Record<string, unknown>,
): ComputerPermissionPresentation | null {
  if (!isBuiltInComputerTool(name)) return null
  const operation = computerOperation(name)
  const approvalLevel = computerToolApprovalLevel(name, args)
  if (!approvalLevel || approvalLevel === 'none') return null
  const target = computerTargetAppName(args)

  if (!isComputerToolOperation(operation)) {
    return {
      title: '电脑操作已阻止',
      question: '此电脑操作不能执行。',
      reason: 'TurboFlux 只允许已注册并经过安全分级的电脑操作。',
      runningDetail: '该电脑操作不可用',
      approvalLevel: 'deny',
    }
  }

  const definition = COMPUTER_TOOLS[operation]
  if (approvalLevel === 'deny') {
    const safetyClass = inferComputerActionSafetyClass(name, args)
    const reason = safetyClass === 'payment'
      ? '付款、购买和资金操作必须由你亲自完成。'
      : safetyClass === 'system'
        ? '管理员授权、系统权限和安全设置必须由你亲自完成。'
        : 'TurboFlux 不会代为输入密码、验证码或其他认证信息。'
    return {
      title: '需要你接管',
      question: target ? `请在 ${target} 中接管并完成这一步。` : '请接管电脑并完成这一步。',
      reason,
      runningDetail: appendTarget('正在等待你接管', target),
      approvalLevel,
    }
  }

  const action = permissionAction(operation, definition.permissionAction || '操作应用', target)
  return {
    title: definition.title,
    question: permissionQuestion(action),
    reason: approvalReason(definition, approvalLevel, inferComputerActionSafetyClass(name, args)),
    runningDetail: appendTarget(definition.running, target),
    approvalLevel,
  }
}

function computerOperation(name: string): string {
  return name.slice(COMPUTER_TOOL_PREFIX.length)
}

function isComputerToolOperation(value: string): value is ComputerToolOperation {
  return COMPUTER_TOOL_SET.has(value)
}

function computerTargetAppName(args: Record<string, unknown>): string | undefined {
  const direct = firstString(args, [
    'app_name',
    'appName',
    'target_app',
    'targetApp',
    'application_name',
    'applicationName',
  ])
  if (direct) return compactLabel(direct)
  for (const key of ['app', 'application', 'target']) {
    const value = args[key]
    if (typeof value === 'string') return compactLabel(value)
    if (isRecord(value)) {
      const nested = firstString(value, ['name', 'app_name', 'appName'])
      if (nested) return compactLabel(nested)
    }
  }
  return undefined
}

function computerSafetyClass(args: Record<string, unknown>): ComputerActionSafetyClass | undefined {
  const value = firstString(args, ['safety_class', 'safetyClass', 'risk'])?.toLowerCase()
  if (value === 'routine' || value === 'low') return 'routine'
  if (value === 'external' || value === 'high-impact') return 'external'
  if (value === 'sensitive') return 'sensitive'
  if (value === 'destructive') return 'destructive'
  if (value === 'payment' || value === 'financial') return 'payment'
  if (value === 'system' || value === 'system-setting') return 'system'
  if (value === 'credential' || value === 'authentication') return 'credential'
  return undefined
}

function hasCredentialSignals(args: Record<string, unknown>): boolean {
  if (args.requires_handoff === true || args.requiresHandoff === true) return true
  if (args.secure === true || args.is_secure_field === true || args.isSecureField === true) return true
  const fieldType = firstString(args, ['field_type', 'fieldType', 'input_type', 'inputType'])?.toLowerCase()
  return fieldType === 'password'
    || fieldType === 'credential'
    || fieldType === 'one-time-code'
    || fieldType === 'otp'
    || fieldType === 'pin'
}

function computerRiskDescriptor(args: Record<string, unknown>): string {
  return [
    'description',
    'reason',
    'app_name',
    'appName',
    'target_label',
    'targetLabel',
    'element_title',
    'elementTitle',
    'element_description',
    'elementDescription',
  ]
    .map(key => typeof args[key] === 'string' ? args[key] : '')
    .filter(Boolean)
    .join(' ')
    .slice(0, 1_000)
}

function approvalReason(
  definition: ComputerToolDefinition,
  approvalLevel: Exclude<ComputerToolApprovalLevel, 'none' | 'deny'>,
  safetyClass?: ComputerActionSafetyClass,
): string {
  if (approvalLevel === 'always') {
    if (safetyClass === 'destructive') return '这可能删除或覆盖内容，完成后可能难以恢复。'
    if (safetyClass === 'payment') return '这涉及付款或交易，需要你逐次确认。'
    if (safetyClass === 'system') return '这会更改系统或账户状态，需要你逐次确认。'
    if (safetyClass === 'external') return '这可能对外发送、发布或提交信息，需要你逐次确认。'
    if (safetyClass === 'sensitive') return '这可能处理敏感信息，需要你逐次确认。'
  }
  return definition.permissionReason || '这会与目标应用交互，并可能改变应用状态。'
}

function permissionAction(operation: ComputerToolOperation, action: string, target?: string): string {
  if (!target) return action
  if (operation === 'focus_app') return `切换到 ${target}`
  if (operation === 'open_app') return `打开 ${target}`
  if (operation === 'handoff') return `接管 ${target}`
  return `在 ${target} 中${action}`
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function compactLabel(value: string): string | undefined {
  const compact = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 36)
  return compact || undefined
}

function permissionQuestion(action: string): string {
  return `允许 TurboFlux ${action}${/[A-Za-z0-9)]$/.test(action) ? ' ' : ''}吗？`
}

function appendTarget(text: string, target?: string): string {
  return target ? `${text} · ${target}` : text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
