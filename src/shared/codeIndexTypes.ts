export type CodeSymbolKind = 'class' | 'function' | 'interface' | 'type' | 'enum' | 'constant'
export type CodeMapNodeKind = 'module' | 'symbol'

export interface CodeAnchor {
  path: string
  line: number
  startLine: number
  endLine: number
}

export interface CodeSearchHit extends CodeAnchor {
  id: string
  source: 'symbol' | 'chunk'
  title: string
  subtitle: string
  preview: string
  score: number
  chunkId?: string
  symbolId?: string
  symbolName?: string
  symbolKind?: CodeSymbolKind
}

export interface CodeMapNode {
  id: string
  kind: CodeMapNodeKind
  title: string
  summary: string
  path?: string
  line?: number
  startLine?: number
  endLine?: number
  score?: number
  children: CodeMapNode[]
}
