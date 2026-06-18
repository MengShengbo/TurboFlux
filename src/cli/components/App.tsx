import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { render, Box, Static, Text, useInput, useApp } from 'ink'
import { ThemeProvider } from '../theme/index'
import { Header } from './header/Header'
import { StatusLine } from './header/StatusLine'
import { ToolCallTree, type ToolStatus } from './tools/ToolCallTree'
import { FileEditStatus, isFileEditToolName } from './tools/FileEditStatus'
import { FastContextBanner } from './tools/FastContextBanner'
import { ConversationHistory, type ConversationEntry } from './ConversationHistory'
import { RewindSelector } from './input/RewindSelector'
import { ModelPicker } from './input/ModelPicker'
import { PermissionDialog, type PermissionDecision } from './permissions/PermissionDialog'
import { MessageList } from './messages/MessageList'
import { useOverlayStack } from '../hooks/useOverlayStack'
import { useMessageCursor } from '../hooks/useMessageCursor'
import type { FastContextScanEvent } from '../../core/fastContextTypes'
import type { AgentTurn, ChangeSummary, TokenUsage } from '../../shared/agentTypes'
import { type Message } from './messages/Messages'
import { PromptInput } from './input/PromptInput'
import { SpinnerGlyph } from './spinner/SpinnerGlyph'
import { formatMarkdown } from './markdown/index'
import type { AgentEventType } from '../../core/agentEngine'
import { createAgentRuntime } from '../../core/runtime/agentRuntime'
import type { ActiveTaskContext } from '../../core/taskManager'
import { applyPreset, getModelPresets, saveConfig, type ModelPreset, type TurboFluxConfig } from '../../core/config'
import { commandRegistry } from '../commands/index'
import type { CommandContext } from '../commands/types'
import { ConversationManager } from '../conversations/manager'
import type { MascotMood } from './header/Mascot'
import { stripTextToolCallMarkup } from '../../shared/toolCallMarkup'
import { useTerminalSize } from '../hooks/useTerminalSize'
import { MAX_INLINE_DIFF_RENDER_ROWS } from './diff/DiffCard'
import { getSafeViewportWidth } from '../terminalLayout'

interface AppProps {
  workspacePath: string
  workspaceName: string
  config: TurboFluxConfig
  singleShot?: string
  verbose: boolean
  noFlicker: boolean
}

type StaticTranscriptItem =
  | { kind: 'header'; id: string }
  | { kind: 'message'; id: string; message: Message }

function isMessageRole(role: string): role is Message['role'] {
  return role === 'user' || role === 'assistant' || role === 'system'
}

function TaskProgressLine({ task }: { task: ActiveTaskContext }) {
  const completed = task.toolCalls.filter(call =>
    call.status === 'completed' || call.status === 'error' || call.status === 'cancelled'
  ).length
  const total = task.toolCalls.length
  const errored = task.toolCalls.filter(call => call.status === 'error').length
  const suffix = total > 0
    ? ` - tools ${completed}/${total}${errored > 0 ? `, ${errored} error${errored === 1 ? '' : 's'}` : ''}`
    : ''
  return (
    <Box>
      <Text dimColor>Task </Text>
      <Text>{task.title}</Text>
      <Text dimColor>{` ${Math.round(task.progress)}%`}</Text>
      <Text dimColor>{suffix}</Text>
    </Box>
  )
}

function turnsToMessages(turns: AgentTurn[]): Message[] {
  const resultByToolCallId = new Map<string, NonNullable<AgentTurn['toolResults']>[number]>()
  for (const turn of turns) {
    if (turn.role !== 'tool_result' || !turn.toolResults) continue
    for (const result of turn.toolResults) resultByToolCallId.set(result.toolCallId, result)
  }

  return turns.flatMap(turn => {
    if (!isMessageRole(turn.role)) return []
    const tools = turn.toolCalls?.map(toolCall => {
      const result = resultByToolCallId.get(toolCall.id)
      return {
        id: toolCall.id,
        name: toolCall.name,
        status: result?.isError ? 'error' as const : 'done' as const,
        args: JSON.stringify(toolCall.arguments).slice(0, 80),
        output: result?.output?.slice(0, 200),
        startTime: turn.timestamp,
        endTime: result ? turn.timestamp + 1 : undefined,
      }
    })
    const changes = turn.toolCalls?.flatMap(toolCall => {
      const summary = resultByToolCallId.get(toolCall.id)?.changeSummary
      return summary ? [summary] : []
    })
    return [{
      id: turn.id,
      role: turn.role,
      content: turn.content,
      tools: tools && tools.length > 0 ? tools : undefined,
      changes: changes && changes.length > 0 ? changes : undefined,
    }]
  })
}

function normalizeEnvFlag(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase()
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = normalizeEnvFlag(value)
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function isFalsyEnv(value: string | undefined): boolean {
  const normalized = normalizeEnvFlag(value)
  return normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off'
}

export function shouldUseNoFlicker(
  interactive: boolean,
  singleShot?: string,
  requested = false,
): boolean {
  if (!interactive || singleShot) return false
  const forced = normalizeEnvFlag(process.env.TURBOFLUX_NO_FLICKER)
  if (isFalsyEnv(forced)) return false
  if (isTruthyEnv(forced)) return true
  return requested
}

function estimateWrappedRows(text: string, columns: number): number {
  const width = Math.max(20, columns - 8)
  const lines = text.split(/\r?\n/)
  return lines.reduce((rows, line) => rows + Math.max(1, Math.ceil(Math.max(1, line.length) / width)), 0)
}

function estimateMessageRows(message: Message, columns: number, diffMaxRows: number): number {
  let rows = 2 + estimateWrappedRows(message.content || ' ', columns)
  if (message.tools?.length) rows += Math.min(8, message.tools.length * 2)
  if (message.changes?.length) {
    rows += message.changes.reduce((sum, change) => {
      const hasSnapshots = change.before !== undefined && change.after !== undefined
      return sum + 1 + (hasSnapshots ? Math.max(1, diffMaxRows) : 1)
    }, 0)
  }
  return rows
}

export function clipTextToRows(text: string, maxRows: number, columns: number): string {
  const width = Math.max(20, columns - 8)
  const lines = text.split(/\r?\n/)
  const kept: string[] = []
  let rows = 0
  let clipped = false

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    const cost = Math.max(1, Math.ceil(Math.max(1, line.length) / width))
    if (kept.length > 0 && rows + cost > maxRows) {
      clipped = true
      break
    }
    if (kept.length === 0 && cost > maxRows) {
      kept.unshift(line.slice(Math.max(0, line.length - width * maxRows)))
      rows = maxRows
      clipped = true
      break
    }
    kept.unshift(line)
    rows += cost
    if (rows >= maxRows) break
  }

  if (!clipped && kept.length === lines.length) return text
  return `[... clipped for screen ...]\n${kept.join('\n')}`
}

export function buildTranscriptSlice(
  messages: Message[],
  rowBudget: number,
  columns: number,
  offsetFromBottom: number,
  diffMaxRows = MAX_INLINE_DIFF_RENDER_ROWS,
): { messages: Message[]; start: number; end: number } {
  if (messages.length === 0) return { messages: [], start: 0, end: 0 }

  const end = Math.max(1, messages.length - offsetFromBottom)
  const output: Message[] = []
  let rows = 0
  let start = end

  for (let i = end - 1; i >= 0; i--) {
    const message = messages[i]!
    const cost = estimateMessageRows(message, columns, diffMaxRows)
    if (output.length > 0 && rows + cost > rowBudget) break

    if (rows + cost > rowBudget) {
      output.unshift({
        ...message,
        tools: undefined,
        changes: undefined,
        content: clipTextToRows(message.content, Math.max(1, rowBudget - 2), columns),
      })
      start = i
      break
    }

    output.unshift(message)
    rows += cost
    start = i
  }

  return { messages: output, start, end }
}

export function getNextTranscriptOffsetAfterAppend(
  currentOffset: number,
  appendedCount: number,
  stickToLatest: boolean,
): number {
  if (stickToLatest) return 0
  return Math.max(0, currentOffset + appendedCount)
}

export function sliceTurnsBeforeNthUserTurn(turns: AgentTurn[], userTurnOrdinal: number): AgentTurn[] {
  if (userTurnOrdinal < 0) return turns

  let seenUsers = 0
  for (let i = 0; i < turns.length; i++) {
    if (turns[i]?.role !== 'user') continue
    if (seenUsers === userTurnOrdinal) {
      return turns.slice(0, i)
    }
    seenUsers += 1
  }

  return turns
}

export function getEngineUserOrdinalForUiMessage(messages: Message[], turns: AgentTurn[], targetMessageIndex: number): number {
  const engineUserTurns = turns.filter(turn => turn.role === 'user')
  let engineUserOrdinal = 0

  for (let i = 0; i <= targetMessageIndex; i++) {
    const message = messages[i]
    if (!message || message.role !== 'user') continue

    const nextEngineTurn = engineUserTurns[engineUserOrdinal]
    const matchesEngineTurn = nextEngineTurn?.content === message.content
    if (i === targetMessageIndex) return engineUserOrdinal
    if (matchesEngineTurn) engineUserOrdinal += 1
  }

  return engineUserOrdinal
}

function App({ workspacePath, workspaceName, config: initialConfig, singleShot, verbose, noFlicker }: AppProps) {
  const { exit } = useApp()
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const terminal = useTerminalSize()
  const noFlickerActive = noFlicker && isInteractive && !singleShot
  const [config, setConfig] = useState(initialConfig)
  const [messages, setMessages] = useState<Message[]>([])
  const [staticTranscriptRevision, setStaticTranscriptRevision] = useState(0)
  const [input, setInput] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [currentTools, setCurrentTools] = useState<ToolStatus[]>([])
  const [mood, setMood] = useState<MascotMood>('idle')
  const [tokenUsage, setTokenUsage] = useState<TokenUsage>({ source: 'unknown' })
  const [currentMode, setCurrentMode] = useState<'vibe' | 'plan'>('vibe')
  const [gitEnabled, setGitEnabled] = useState(false)
  const [modelPresets, setModelPresets] = useState<ModelPreset[]>([])
  const [lastActivity, setLastActivity] = useState<number>(Date.now())
  const [convListRevision, setConvListRevision] = useState(0)
  const [fcEvents, setFcEvents] = useState<FastContextScanEvent[]>([])
  const [fcActive, setFcActive] = useState(false)
  const [activeTask, setActiveTask] = useState<ActiveTaskContext | null>(null)
  const [changeSummaries, setChangeSummaries] = useState<ChangeSummary[]>([])
  const [pendingAsk, setPendingAsk] = useState<{
    question: string
    options?: string[]
    reason?: string
    command?: string
  } | null>(null)
  const [askInput, setAskInput] = useState('')
  const { active: activeOverlay, push, pop } = useOverlayStack()
  const { cursor, enter, navigatePrev, navigateNext, clear } = useMessageCursor(messages)
  const [cursorMode, setCursorMode] = useState(false)
  const [transcriptOffset, setTranscriptOffset] = useState(0)
  const transcriptOffsetRef = useRef(0)
  const messageIdRef = useRef(0)
  const streamBufferRef = useRef('')
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const genMsgId = useCallback(() => {
    messageIdRef.current += 1
    return `msg-${messageIdRef.current}`
  }, [])

  // Refs to avoid stale closures in the engine event subscription (effect runs once)
  const currentToolsRef = useRef<ToolStatus[]>([])
  const changeSummariesRef = useRef<ChangeSummary[]>([])
  useEffect(() => { currentToolsRef.current = currentTools }, [currentTools])
  useEffect(() => { changeSummariesRef.current = changeSummaries }, [changeSummaries])

  const [runtime] = useState(() => createAgentRuntime({
    workspacePath,
    workspaceName,
    config: initialConfig,
    conversationPrefix: 'cli',
    registerSkills: skillRuntime => commandRegistry.registerSkills(skillRuntime),
  }))
  const { engine, stateProvider, skillRuntime, mcpClient } = runtime
  const [convManager] = useState(() => new ConversationManager(engine, config, workspacePath))

  const persistConfig = useCallback((nextConfig: TurboFluxConfig) => {
    stateProvider.updateConfig(nextConfig)
    convManager.updateConfig(nextConfig)
    setConfig(nextConfig)
    saveConfig(nextConfig)
  }, [stateProvider, convManager])

  const clearStreamFlushTimer = useCallback(() => {
    if (streamFlushTimerRef.current) {
      clearTimeout(streamFlushTimerRef.current)
      streamFlushTimerRef.current = null
    }
  }, [])

  const appendMessages = useCallback((nextMessages: Message[], options?: { forceLatest?: boolean }) => {
    if (nextMessages.length === 0) return

    setMessages(msgs => [...msgs, ...nextMessages])

    if (!noFlickerActive) return

    const stickToLatest = options?.forceLatest === true || transcriptOffsetRef.current === 0
    setTranscriptOffset(offset => getNextTranscriptOffsetAfterAppend(offset, nextMessages.length, stickToLatest))
  }, [noFlickerActive])

  const replaceMessages = useCallback((nextMessages: React.SetStateAction<Message[]>) => {
    setStaticTranscriptRevision(revision => revision + 1)
    setMessages(nextMessages)
  }, [])

  const restoreCliStateFromTurns = useCallback((turns: AgentTurn[], nextInput = '', contextSegments = stateProvider.getContextSegments()) => {
    engine.restoreFromTurns(turns)
    engine.setContextSegments(contextSegments)
    replaceMessages(turnsToMessages(turns))
    setInput(nextInput)
    setTranscriptOffset(0)
    setTokenUsage(engine.getContextUsage())
    setGitEnabled(engine.isGitEnabled())
    setCurrentTools([])
    setChangeSummaries([])
    streamBufferRef.current = ''
    clearStreamFlushTimer()
    setStreamText('')
    setFcEvents([])
    setFcActive(false)
    setActiveTask(null)
    setPendingAsk(null)
    setAskInput('')
    setCursorMode(false)
    clear()
    setIsRunning(false)
    setMood('idle')
  }, [engine, stateProvider, clearStreamFlushTimer, clear, replaceMessages])

  const getRewindContextSegments = useCallback((turns: AgentTurn[]) => {
    const boundaryTime = turns.reduce((max, turn) => Math.max(max, turn.timestamp), 0)
    return stateProvider.getContextSegments().filter(segment => {
      if (typeof segment.createdAt !== 'number') return true
      return segment.createdAt <= boundaryTime
    })
  }, [stateProvider])

  useEffect(() => {
    stateProvider.updateConfig(config)
    convManager.updateConfig(config)
  }, [stateProvider, convManager, config])

  useEffect(() => {
    let cancelled = false
    getModelPresets(config.baseUrl)
      .then(presets => {
        if (!cancelled) setModelPresets(presets)
      })
      .catch(() => {
        if (!cancelled) setModelPresets([])
      })
    return () => { cancelled = true }
  }, [config.baseUrl])

  useEffect(() => {
    const unsub = engine.subscribe((event: AgentEventType) => {
      switch (event.type) {
        case 'stream:start':
          setIsRunning(true)
          streamBufferRef.current = ''
          clearStreamFlushTimer()
          break
        case 'stream:delta':
          streamBufferRef.current += event.text
          if (!streamFlushTimerRef.current) {
            streamFlushTimerRef.current = setTimeout(() => {
              streamFlushTimerRef.current = null
              setStreamText(streamBufferRef.current)
            }, 80)
          }
          setLastActivity(Date.now())
          break
        case 'stream:end': {
          clearStreamFlushTimer()
          const bufferedStreamText = streamBufferRef.current
          streamBufferRef.current = ''
          const toolsSnapshot = currentToolsRef.current
          const changesSnapshot = changeSummariesRef.current
          const visibleText = stripTextToolCallMarkup(bufferedStreamText, { stripIncomplete: true })
          if (visibleText || toolsSnapshot.length > 0 || changesSnapshot.length > 0) {
            appendMessages([{ id: genMsgId(), role: 'assistant', content: visibleText, tools: [...toolsSnapshot], changes: [...changesSnapshot] }])
          }
          setStreamText('')
          setCurrentTools([])
          setChangeSummaries([])
          setIsRunning(false)
          setMood('happy')
          setTokenUsage(engine.getContextUsage())
          convManager.scheduleSave()
          setTimeout(() => setMood('idle'), 3000)
          break
        }
        case 'session:complete':
          convManager.scheduleSave()
          break
        case 'tool:call':
          if (event.toolCall.name === 'spawn_agent') break
          setCurrentTools(prev => [...prev, {
            id: event.toolCall.id,
            name: event.toolCall.name,
            status: 'running',
            args: event.toolCall.arguments ? JSON.stringify(event.toolCall.arguments).slice(0, 80) : undefined,
            startTime: Date.now(),
          }])
          setLastActivity(Date.now())
          break
        case 'tool:result':
          setCurrentTools(prev =>
            prev.map(t => t.id === event.toolResult.toolCallId
              ? { ...t, status: event.toolResult.isError ? 'error' : 'done', output: event.toolResult.output?.slice(0, 200), endTime: Date.now() }
              : t
            )
          )
          if (event.toolResult.changeSummary) {
            setChangeSummaries(prev => [...prev, event.toolResult.changeSummary!])
          }
          setLastActivity(Date.now())
          break
        case 'fast_context:event':
          setFcEvents(prev => [...prev, event.event])
          setFcActive(true)
          setLastActivity(Date.now())
          break
        case 'fast_context:complete':
          setFcActive(false)
          break
        case 'active:task':
          setActiveTask(event.context)
          break
        case 'ask:user':
          setPendingAsk({
            question: event.question,
            options: event.options,
            reason: event.reason,
            command: event.command,
          })
          setAskInput('')
          setMood('thinking')
          break
        case 'context:segment_created':
          convManager.scheduleSave()
          setLastActivity(Date.now())
          break
        case 'error':
          streamBufferRef.current = ''
          clearStreamFlushTimer()
          setStreamText('')
          appendMessages([{ id: genMsgId(), role: 'system', content: `Error: ${event.error}` }])
          setIsRunning(false)
          setMood('error')
          setTimeout(() => setMood('idle'), 4000)
          break
        case 'mode:change':
          setCurrentMode(event.to)
          setGitEnabled(engine.isGitEnabled())
          break
      }
    })
    return () => {
      clearStreamFlushTimer()
      unsub()
      convManager.destroy()
      runtime.destroy().catch(() => {})
    }
  }, [engine, runtime, clearStreamFlushTimer, appendMessages])

  const getConversationEntries = useCallback((): ConversationEntry[] => {
    const convs = convManager.list()
    const currentId = convManager.getCurrentId()
    return convs.map(c => ({
      id: c.id,
      title: c.title || c.id.slice(0, 12),
      turnCount: c.turnCount,
      updatedAt: c.updatedAt,
      isCurrent: c.id === currentId,
    }))
  }, [convManager])

  useEffect(() => {
    if (singleShot) runPrompt(singleShot)
  }, [])

  const transcriptRowBudget = useMemo(() => {
    if (!noFlickerActive) return Number.MAX_SAFE_INTEGER
    const headerRows = terminal.columns < 60 ? 17 : 14
    const bottomRows = pendingAsk ? 8 : 3
    return Math.max(4, terminal.rows - headerRows - bottomRows)
  }, [noFlickerActive, terminal.rows, terminal.columns, pendingAsk])
  const maxTranscriptOffset = Math.max(0, messages.length - 1)
  const normalizedTranscriptOffset = noFlickerActive
    ? Math.min(transcriptOffset, maxTranscriptOffset)
    : 0
  transcriptOffsetRef.current = normalizedTranscriptOffset
  const transcriptSlice = useMemo(() => {
    if (!noFlickerActive) return { messages, start: 0, end: messages.length }
    return buildTranscriptSlice(messages, transcriptRowBudget, terminal.columns, normalizedTranscriptOffset, 0)
  }, [noFlickerActive, messages, transcriptRowBudget, terminal.columns, normalizedTranscriptOffset])
  const transcriptEnd = transcriptSlice.end
  const transcriptStart = transcriptSlice.start
  const visibleMessages = transcriptSlice.messages
  const selectedMessageIndex = cursorMode ? cursor?.index : undefined
  const visibleSelectedIndex = selectedMessageIndex !== undefined &&
    selectedMessageIndex >= transcriptStart &&
    selectedMessageIndex < transcriptEnd
      ? selectedMessageIndex - transcriptStart
      : undefined
  const hiddenBefore = transcriptStart
  const hiddenAfter = messages.length - transcriptEnd
  const pageStep = Math.max(1, Math.floor(Math.max(visibleMessages.length, 4) / 2))
  const isViewingHistory = normalizedTranscriptOffset > 0

  useEffect(() => {
    setTranscriptOffset(offset => Math.min(offset, maxTranscriptOffset))
  }, [maxTranscriptOffset])

  useEffect(() => {
    if (!noFlickerActive || !cursorMode || !cursor) return
    if (cursor.index < transcriptStart) {
      setTranscriptOffset(Math.max(0, messages.length - cursor.index - 1))
      return
    }

    if (cursor.index >= transcriptEnd) {
      setTranscriptOffset(Math.max(0, messages.length - cursor.index - 1))
    }
  }, [
    noFlickerActive,
    cursorMode,
    cursor?.index,
    messages.length,
    transcriptStart,
    transcriptEnd,
  ])

  const runPrompt = useCallback(async (prompt: string) => {
    appendMessages([{ id: genMsgId(), role: 'user', content: prompt }])
    if (!config.apiKey) {
      appendMessages([{ id: genMsgId(), role: 'system', content: 'No model provider is configured yet. Exit and run `turboflux setup`, or set `/config apiKey <key>` manually.' }])
      if (singleShot) exit()
      return
    }
    setIsRunning(true)
    setMood('thinking')
    streamBufferRef.current = ''
    clearStreamFlushTimer()
    setStreamText('')
    setCurrentTools([])
    setFcEvents([])
    setFcActive(false)
    setActiveTask(null)
    setChangeSummaries([])
    setPendingAsk(null)
    setAskInput('')
    setLastActivity(Date.now())
    try {
      const turns = await engine.run(prompt)
      if (singleShot) {
        const finalAssistantTurn = [...turns].reverse().find(turn => turn.role === 'assistant' && turn.content.trim())
        const finalText = finalAssistantTurn
          ? stripTextToolCallMarkup(finalAssistantTurn.content, { stripIncomplete: true }).trim()
          : ''
        if (finalText) {
          process.stdout.write(`\n${formatMarkdown(finalText)}\n`)
        }
      }
    } catch (e: any) {
      streamBufferRef.current = ''
      clearStreamFlushTimer()
      setStreamText('')
      appendMessages([{ id: genMsgId(), role: 'system', content: `Error: ${e.message}` }])
      setIsRunning(false)
      setMood('error')
      setTimeout(() => setMood('idle'), 4000)
    }
    if (singleShot) exit()
  }, [appendMessages, engine, singleShot, config, clearStreamFlushTimer, exit])

  const submitAskResponse = useCallback((response: string) => {
    engine.submitAskUserResponse(response)
    setPendingAsk(null)
    setAskInput('')
  }, [engine])

  const isPermissionAsk = pendingAsk?.options?.includes('allow-once') ?? false

  const handleSubmit = useCallback((value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return
    setInput('')

    if (commandRegistry.isCommand(trimmed)) {
      if (trimmed === '/model') {
        push('modelPicker')
        return
      }
      if (trimmed === '/resume') {
        push('history')
        return
      }
      const ctx: CommandContext = {
        engine,
        config,
        modelPresets,
        workspacePath,
        setConfig: persistConfig,
        setMessages: replaceMessages,
        restoreConversation: (turns, nextInput) => restoreCliStateFromTurns(turns, nextInput),
        exit,
        conversationManager: convManager,
        skillRuntime,
        mcpClient,
      }
      const result = commandRegistry.execute(trimmed, ctx)
      setTokenUsage(engine.getContextUsage())
      setGitEnabled(engine.isGitEnabled())
      switch (result.type) {
        case 'text':
          appendMessages([{ id: genMsgId(), role: 'system', content: result.text! }])
          break
        case 'prompt':
          runPrompt(result.prompt!)
          break
        case 'none':
          break
      }
      return
    }
    runPrompt(trimmed)
  }, [appendMessages, config, convManager, engine, exit, mcpClient, modelPresets, persistConfig, push, restoreCliStateFromTurns, runPrompt, skillRuntime, workspacePath])

  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') exit()
    if (activeOverlay !== null) return // overlays handle their own keys

    if (noFlickerActive && !cursorMode) {
      if (key.pageUp || (key.ctrl && key.upArrow)) {
        setTranscriptOffset(offset => Math.min(maxTranscriptOffset, offset + pageStep))
        return
      }
      if (key.pageDown || (key.ctrl && key.downArrow)) {
        setTranscriptOffset(offset => Math.max(0, offset - pageStep))
        return
      }
    }

    if (key.ctrl && ch === 'h') {
      push('history')
      return
    }

    if (cursorMode) {
      if (key.upArrow) { navigatePrev(); return }
      if (key.downArrow) { navigateNext(); return }
      if (key.escape || key.return) {
        setCursorMode(false)
        clear()
        return
      }
    }

    if (key.ctrl && ch === 'm' && messages.length > 0) {
      setCursorMode(true)
      enter()
    }
  }, { isActive: isInteractive })

  const visibleStreamText = stripTextToolCallMarkup(streamText, { stripIncomplete: true })
  const streamTextForDisplay = noFlickerActive
    ? clipTextToRows(visibleStreamText, Math.max(2, Math.floor(transcriptRowBudget / 2)), terminal.columns)
    : visibleStreamText

  const runningNode = isRunning ? (
    <Box flexDirection="column" marginBottom={1}>
      {(fcActive || fcEvents.length > 0) && <FastContextBanner events={fcEvents} isActive={fcActive} />}
      {activeTask && <TaskProgressLine task={activeTask} />}
      <FileEditStatus tools={currentTools} />
      {currentTools.filter(tool => !(tool.status === 'running' && isFileEditToolName(tool.name))).length > 0 && (
        <ToolCallTree
          tools={currentTools.filter(tool => !(tool.status === 'running' && isFileEditToolName(tool.name)))}
          verbose={verbose}
        />
      )}
      {streamTextForDisplay && <Text>{formatMarkdown(streamTextForDisplay)}</Text>}
      {!visibleStreamText && currentTools.length === 0 && !fcActive && !pendingAsk && (
        <Box><SpinnerGlyph lastActivity={lastActivity} label="Thinking..." /></Box>
      )}
    </Box>
  ) : null

  const pendingAskNode = pendingAsk ? (
    <Box flexDirection="column" marginBottom={1}>
      {isPermissionAsk ? (
        <PermissionDialog
          toolName={pendingAsk.command ? 'run_command' : 'tool'}
          description={pendingAsk.reason || pendingAsk.question}
          command={pendingAsk.command}
          onDecision={(decision: PermissionDecision) => submitAskResponse(decision)}
        />
      ) : (
        <Box flexDirection="column" borderStyle="round" paddingX={1} marginY={1}>
          <Text bold>Confirmation needed</Text>
          <Text>{pendingAsk.question}</Text>
          {pendingAsk.reason && <Text dimColor>{pendingAsk.reason}</Text>}
          {pendingAsk.command && <Text>{pendingAsk.command}</Text>}
          {pendingAsk.options?.length ? <Text dimColor>{pendingAsk.options.join(' / ')}</Text> : null}
          <PromptInput
            value={askInput}
            onChange={setAskInput}
            onSubmit={submitAskResponse}
            mode={currentMode}
          />
        </Box>
      )}
    </Box>
  ) : null

  const handleRewind = useCallback((messageIndex: number) => {
    const targetMessage = messages[messageIndex]
    if (!targetMessage || targetMessage.role !== 'user') return

    const currentTurns = engine.getSession().turns
    const engineUserOrdinal = getEngineUserOrdinalForUiMessage(messages, currentTurns, messageIndex)
    const truncatedTurns = sliceTurnsBeforeNthUserTurn(currentTurns, engineUserOrdinal)

    pop()
    restoreCliStateFromTurns(truncatedTurns, targetMessage.content, getRewindContextSegments(truncatedTurns))
    convManager.scheduleSave()
  }, [messages, engine, pop, restoreCliStateFromTurns, getRewindContextSegments, convManager])

  const historyOverlay = activeOverlay === 'history' ? (
    <ConversationHistory
      key={convListRevision}
      conversations={getConversationEntries()}
      onSelect={(id) => {
        pop()
        const conv = convManager.switchTo(id)
        if (conv) {
          restoreCliStateFromTurns(conv.turns, '', conv.contextSegments ?? [])
        }
      }}
      onDelete={(id) => {
        convManager.delete(id)
        setConvListRevision(r => r + 1)
      }}
      onCancel={() => pop()}
    />
  ) : null

  const rewindOverlay = activeOverlay === 'rewind' ? (
    <RewindSelector
      messages={messages}
      onRewind={handleRewind}
      onCancel={() => pop()}
    />
  ) : null

  const modelOverlay = activeOverlay === 'modelPicker' ? (
    <ModelPicker
      currentModel={config.model}
      models={modelPresets}
      onSelect={(preset) => {
        pop()
        const newConfig = applyPreset(config, preset)
        persistConfig(newConfig)
        appendMessages([{ id: genMsgId(), role: 'system', content: `Model switched to ${preset.model}` }])
      }}
      onCancel={() => pop()}
    />
  ) : null

  const overlayNode = historyOverlay ?? rewindOverlay ?? modelOverlay
  const showPrompt = !isRunning && !singleShot && activeOverlay === null && !cursorMode && !pendingAsk
  const cursorPreviewMessage = cursorMode && !noFlickerActive && cursor ? messages[cursor.index] : undefined
  const cursorHint = cursorMode ? (
    <Box marginTop={1}>
      <Text dimColor>Message cursor: Up/Down navigate - Enter/Esc exit</Text>
    </Box>
  ) : null
  const cursorPreviewNode = cursorPreviewMessage ? (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>{`Selected message ${cursor!.index + 1}/${messages.length}`}</Text>
      <MessageList
        messages={[{
          ...cursorPreviewMessage,
          content: clipTextToRows(cursorPreviewMessage.content, 8, terminal.columns),
          tools: undefined,
          changes: undefined,
        }]}
        verbose={verbose}
        diffMaxRows={0}
        selectedIndex={0}
      />
    </Box>
  ) : null
  const promptNode = showPrompt ? (
    <PromptInput
      value={input}
      onChange={setInput}
      onSubmit={handleSubmit}
      onDoubleEsc={() => {
        if (messages.length > 0) push('rewind')
      }}
      mode={currentMode}
    />
  ) : null
  const transcriptHint = noFlickerActive && activeOverlay === null && (hiddenBefore > 0 || hiddenAfter > 0) ? (
    <Box flexShrink={0}>
      <Text dimColor>
        {hiddenAfter > 0
          ? `History view - ${hiddenBefore} earlier, ${hiddenAfter} newer - PgDn for latest`
          : `${hiddenBefore} earlier messages hidden - PgUp/PgDn or Ctrl+Up/Down to scroll`}
      </Text>
    </Box>
  ) : null
  const dynamicMessages = visibleMessages
  const hasTranscriptContent = dynamicMessages.length > 0 || Boolean(runningNode) || Boolean(transcriptHint) // kept for potential diagnostics
  const transcriptNode = (
    <>
      {transcriptHint}
      <MessageList
        messages={dynamicMessages}
        verbose={verbose}
        diffMaxRows={noFlickerActive ? 0 : MAX_INLINE_DIFF_RENDER_ROWS}
        selectedIndex={visibleSelectedIndex}
      />
      {runningNode}
    </>
  )
  const staticTranscriptItems = useMemo<StaticTranscriptItem[]>(() => [
    { kind: 'header', id: 'startup-header' },
    ...messages.map(message => ({ kind: 'message' as const, id: message.id, message })),
  ], [messages])

  if (noFlickerActive) {
    return (
      <ThemeProvider>
        <Box flexDirection="column" paddingX={1} width={getSafeViewportWidth(terminal.columns)} height={terminal.rows} overflow="hidden">
          <Box flexShrink={0}>
            <Header
              workspaceName={workspaceName}
              model={config.model}
              mood={mood}
              hasApiKey={!!config.apiKey}
            />
          </Box>

          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            <Box flexDirection="column" flexShrink={1} overflow="hidden">
              {overlayNode ?? transcriptNode}
            </Box>
            <Box flexDirection="column" flexShrink={0}>
              {pendingAskNode}
              {cursorHint}
              {promptNode}
              <StatusLine config={config} tokenUsage={tokenUsage} mode={currentMode} viewingHistory={isViewingHistory} gitEnabled={gitEnabled} />
            </Box>
          </Box>
        </Box>
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider>
      <Static key={staticTranscriptRevision} items={staticTranscriptItems}>
        {item => (
          item.kind === 'header'
            ? (
              <Box key={item.id} flexDirection="column" paddingX={1}>
                <Header
                  workspaceName={workspaceName}
                  model={config.model}
                  mood="idle"
                  hasApiKey={!!config.apiKey}
                />
              </Box>
            )
            : (
              <Box key={item.id} flexDirection="column" paddingX={1}>
                <MessageList
                  messages={[item.message]}
                  verbose={verbose}
                  diffMaxRows={MAX_INLINE_DIFF_RENDER_ROWS}
                />
              </Box>
            )
        )}
      </Static>

      <Box flexDirection="column" paddingX={1}>
        {/* Streaming / loading area */}
        {runningNode}

        {pendingAskNode}

        {/* Conversation history overlay */}
        {historyOverlay}

        {/* Rewind overlay */}
        {rewindOverlay}

        {/* Model picker overlay */}
        {modelOverlay}

        {/* Input area */}
        {cursorHint}
        {cursorPreviewNode}
        {promptNode}

        {/* Status line at bottom */}
        <StatusLine config={config} tokenUsage={tokenUsage} mode={currentMode} viewingHistory={isViewingHistory} gitEnabled={gitEnabled} />
      </Box>
    </ThemeProvider>
  )
}

export function startInkApp(options: {
  workspacePath: string
  config: TurboFluxConfig
  singleShot?: string
  verbose: boolean
  noFlicker?: boolean
}) {
  const workspaceName = options.workspacePath.split(/[\\/]/).pop() || 'workspace'
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const noFlicker = shouldUseNoFlicker(interactive, options.singleShot, options.noFlicker === true)
  render(
    <App
      workspacePath={options.workspacePath}
      workspaceName={workspaceName}
      config={options.config}
      singleShot={options.singleShot}
      verbose={options.verbose}
      noFlicker={noFlicker}
    />,
    {
      maxFps: noFlicker ? 24 : 18,
      incrementalRendering: noFlicker,
      interactive,
      alternateScreen: noFlicker,
    }
  )
}
